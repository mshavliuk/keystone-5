const fs = require('fs');
const path = require('path');
const util = require('util');
const cuid = require('cuid');
const pSettle = require('p-settle');
const {
  escapeRegExp,
  pick,
  getType,
  mapKeys,
  mapKeyNames,
  identity,
  spliceImmutably,
} = require('@keystone-alpha/utils');

const {
  BaseKeystoneAdapter,
  BaseListAdapter,
  BaseFieldAdapter,
} = require('@keystone-alpha/keystone');
const logger = require('@keystone-alpha/logger').logger('json-adapter');

const simpleTokenizer = require('./tokenizers/simple');
const relationshipTokenizer = require('./tokenizers/relationship');
const getRelatedListAdapterFromQueryPathFactory = require('./tokenizers/relationship-path');

class JSONAdapter extends BaseKeystoneAdapter {
  constructor() {
    super(...arguments);

    this.name = this.name || 'json';

    this.listAdapterClass = JSONListAdapter;
  }

  async _connect(to = './database.json') {
    this._fd = await util.promisify(fs.open)(path.resolve(to));

    // Make sure we gracefully clean up on process exit
    process.on('SIGINT', () => this.disconnect())
    process.on('SIGTERM', () => this.disconnect())
  }

  async read() {
    try {
      return JSON.parse(await util.promisify(fs.readFile)(this._fd)) || {};
    } catch (error) {
      return {};
    }
  }

  async write(lists) {
    return util.promisify(fs.writeFile)(this._fd, JSON.stringify(lists));
  }

  async readList(listKey) {
    return (await this.read())[listKey];
  }

  async writeList(listKey, items) {
    const lists = await this.read();
    lists[listKey] = items;
    return this.write(lists);
  }

  async disconnect() {
    if (!this._fd) {
      return;
    }
    await util.promisify(fs.close)(this._fd);
    this._fd = null;
  }

  // This will completely drop the backing database. Use wisely.
  dropDatabase() {
    return this.write({});
  }
}

class JSONListAdapter extends BaseListAdapter {
  constructor(key, parentAdapter, config) {
    super(...arguments);

    this._parentAdapter = parentAdapter;
    this.getListAdapterByKey = parentAdapter.getListAdapterByKey.bind(parentAdapter);
  }

  prepareFieldAdapter(fieldAdapter) {
    // TODO
    throw new Error('JSONListAdapter#prepareFieldAdapter() not implemented');
  }

  _read() {
    return this._parentAdapter.readList(this.key);
  }

  _write(items) {
    return this._parentAdapter.writeList(this.key, items);
  }

  async _create(input) {
    const items = await this._read();
    const data = {
      ...input,
      id: cuid(),
    };
    await this._write(items.concat([data]));
    return data;
  }

  async _delete(id) {
    let oldItem = null;
    const items = (await this._read()).filter(item => {
      if (item.id !== id) {
        return true;
      }
      oldItem = item;
      return false;
    });
    await this._write(items);
    return oldItem;
  }

  async _update(id, data) {
    const items = await this._read();
    const itemIndex = items.findIndex(item => item.id === id);
    if (itemIndex === -1) {
      // it doesn't exist, so return null as a fallback to the "return the
      // new item" API.
      return null;
    }
    await this._write(spliceImmutably(items, itemIndex, 1, [data]));
    return data;
  }

  _findAll() {
    return this._read();
  }

  async _findById(id) {
    const items = await this._read();
    const itemIndex = items.findIndex(item => item.id === id);
    if (itemIndex === -1) {
      // it doesn't exist, so return null as a fallback to the "return the
      // replaced item" API.
      return null;
    }
    return items[itemIndex];
  }

  _find(condition) {
    // TODO
    debugger;
    throw new Error('JSONAdapter#_find() not implemented');
  }

  _findOne(condition) {
    // TODO
    debugger;
    throw new Error('JSONAdapter#_findOne() not implemented');
  }

  _itemsQuery(args, { meta = false } = {}) {
    // TODO
    debugger;
    throw new Error('JSONAdapter#_itemsQuery() not implemented');



    //function graphQlQueryToMongoJoinQuery(query) {
    //  const _query = {
    //    ...query.where,
    //    ...mapKeyNames(
    //      // Grab all the modifiers
    //      pick(query, ['search', 'orderBy', 'skip', 'first']),
    //      // and prefix with a dollar symbol so they can be picked out by the
    //      // query builder tokeniser
    //      key => `$${key}`
    //    ),
    //  };

    //  return mapKeys(_query, field => {
    //    if (getType(field) !== 'Object' || !field.where) {
    //      return field;
    //    }

    //    // recurse on object (ie; relationship) types
    //    return graphQlQueryToMongoJoinQuery(field);
    //  });
    //}

    //let query;
    //try {
    //  query = graphQlQueryToMongoJoinQuery(args);
    //} catch (error) {
    //  return Promise.reject(error);
    //}

    //if (meta) {
    //  // Order is important here, which is why we do it last (v8 will append the
    //  // key, and keep them stable)
    //  query.$count = 'count';
    //}
  }
}

class JSONFieldAdapter extends BaseFieldAdapter {
  // The following methods provide helpers for constructing the return values of `getQueryConditions`.
  // Each method takes:
  //   `dbPath`: The database field/column name to be used in the comparison
  //   `f`: (non-string methods only) A value transformation function which converts from a string type
  //        provided by graphQL into a native adapter type.
  equalityConditions(dbPath, f = identity) {
    return {
      [this.path]: value => item => item[dbPath] === f(value),
      [`${this.path}_not`]: value => item => item[dbPath] !== f(value),
    };
  }

  equalityConditionsInsensitive(dbPath) {
    const f = escapeRegExp;
    return {
      [`${this.path}_i`]: value => item => (new RegExp(`^${f(value)}$`, 'i')).test(item[dbPath]),
      [`${this.path}_not_i`]: value => item => !(new RegExp(`^${f(value)}$`, 'i')).test(item[dbPath]),
    };
  }

  inConditions(dbPath, f = identity) {
    return {
      [`${this.path}_in`]: value => item => !!value.find(s => f(s) === item[dbPath]),
      [`${this.path}_not_in`]: value => item => !value.find(s => f(s) === item[dbPath]),
    };
  }

  orderingConditions(dbPath, f = identity) {
    return {
      [`${this.path}_lt`]: value => item => item[dbPath] < f(value),
      [`${this.path}_lte`]: value => item => item[dbPath] <= f(value),
      [`${this.path}_gt`]: value => item => item[dbPath] > f(value),
      [`${this.path}_gte`]: value => item => item[dbPath] >= f(value),
    };
  }

  stringConditions(dbPath) {
    const f = escapeRegExp;
    return {
      [`${this.path}_contains`]: value => item => (new RegExp(f(value))).test(item[dbPath]),
      [`${this.path}_not_contains`]: value => item => !(new RegExp(f(value))).test(item[dbPath]),
      [`${this.path}_starts_with`]: value => item => (new RegExp(`^${f(value)}`)).test(item[dbPath]),
      [`${this.path}_not_starts_with`]: value => item => !(new RegExp(`^${f(value)}`)).test(item[dbPath]),
      [`${this.path}_ends_with`]: value => item => (new RegExp(`${f(value)}$`)).test(item[dbPath]),
      [`${this.path}_not_ends_with`]: value => item => !(new RegExp(`${f(value)}$`)).test(item[dbPath]),
    };
  }

  stringConditionsInsensitive(dbPath) {
    const f = escapeRegExp;
    return {
      [`${this.path}_contains_i`]: value => item => (new RegExp(f(value), 'i')).test(item[dbPath]),
      [`${this.path}_not_contains_i`]: value => item => !(new RegExp(f(value), 'i')).test(item[dbPath]),
      [`${this.path}_starts_with_i`]: value => item => (new RegExp(`^${f(value)}`, 'i')).test(item[dbPath]),
      [`${this.path}_not_starts_with_i`]: value => item => !(new RegExp(`^${f(value)}`, 'i')).test(item[dbPath]),
      [`${this.path}_ends_with_i`]: value => item => (new RegExp(`${f(value)}$`, 'i')).test(item[dbPath]),
      [`${this.path}_not_ends_with_i`]: value => item => !(new RegExp(`${f(value)}$`, 'i')).test(item[dbPath]),
    };
  }
}

JSONAdapter.defaultListAdapterClass = JSONListAdapter;

module.exports = {
  JSONAdapter,
  JSONListAdapter,
  JSONFieldAdapter,
};

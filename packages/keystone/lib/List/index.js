const pluralize = require('pluralize');
const {
  resolveAllKeys,
  mapKeys,
  omit,
  unique,
  intersection,
  mergeWhereClause,
  objMerge,
  arrayToObject,
  flatten,
  zipObj,
  createLazyDeferred,
} = require('@keystone-alpha/utils');
const { parseListAccess } = require('@keystone-alpha/access-control');
const { logger } = require('@keystone-alpha/logger');
const gql = require('graphql-tag');

const graphqlLogger = logger('graphql');
const keystoneLogger = logger('keystone');

const { AccessDeniedError, ValidationFailureError } = require('./graphqlErrors');

const upcase = str => str.substr(0, 1).toUpperCase() + str.substr(1);

const preventInvalidUnderscorePrefix = str => str.replace(/^__/, '_');

const keyToLabel = str => {
  let label = str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s|_|\-/)
    .filter(i => i)
    .map(upcase)
    .join(' ');

  // Retain the leading underscore for auxiliary lists
  if (str[0] === '_') {
    label = `_${label}`;
  }
  return label;
};

const labelToPath = str =>
  str
    .split(' ')
    .join('-')
    .toLowerCase();

const labelToClass = str => str.replace(/\s+/g, '');

const opToType = {
  read: 'query',
  create: 'mutation',
  update: 'mutation',
  delete: 'mutation',
};

const getAuthMutationName = (prefix, authType) => `${prefix}With${upcase(authType)}`;

const mapNativeTypeToKeystoneType = (type, listKey, fieldPath) => {
  const { Text, Checkbox, Float } = require('@keystone-alpha/fields');

  const nativeTypeMap = new Map([
    [
      Boolean,
      {
        name: 'Boolean',
        keystoneType: Checkbox,
      },
    ],
    [
      String,
      {
        name: 'String',
        keystoneType: Text,
      },
    ],
    [
      Number,
      {
        name: 'Number',
        keystoneType: Float,
      },
    ],
  ]);

  if (!nativeTypeMap.has(type)) {
    return type;
  }

  const { name, keystoneType } = nativeTypeMap.get(type);

  keystoneLogger.warn(
    { nativeType: type, keystoneType, listKey, fieldPath },
    `Mapped field ${listKey}.${fieldPath} from native JavaScript type '${name}', to '${
      keystoneType.type.type
    }' from the @keystone-alpha/fields package.`
  );

  return keystoneType;
};

module.exports = class List {
  constructor(
    key,
    {
      fields,
      hooks = {},
      mutations = [],
      schemaDoc,
      labelResolver,
      labelField,
      access,
      adminConfig = {},
      itemQueryName,
      listQueryName,
      label,
      singular,
      plural,
      path,
      adapterConfig = {},
    },
    {
      getListByKey,
      getGraphQLQuery,
      adapter,
      defaultAccess,
      getAuth,
      registerType,
      createAuxList,
      isAuxList,
    }
  ) {
    this.key = key;
    this._fields = fields;
    this.hooks = hooks;
    this.mutations = mutations;
    this.schemaDoc = schemaDoc;
    // 180814 JM TODO: Since there's no access control specified, this implicitly makes name, id or {labelField} readable by all (probably bad?)
    this.adminConfig = {
      defaultPageSize: 50,
      defaultColumns: Object.keys(fields)
        .slice(0, 2)
        .join(','),
      defaultSort: Object.keys(fields)[0],
      maximumPageSize: 1000,
      ...adminConfig,
    };
    this.labelResolver = labelResolver || (item => item[labelField || 'name'] || item.id);
    this.isAuxList = isAuxList;
    this.getListByKey = getListByKey;
    this.defaultAccess = defaultAccess;
    this.getAuth = getAuth;
    this.hasAuth = () => !!Object.keys(getAuth() || {}).length;
    this.createAuxList = createAuxList;

    const _label = keyToLabel(key);
    const _singular = pluralize.singular(_label);
    const _plural = pluralize.plural(_label);

    if (_plural === _label) {
      throw new Error(
        `Unable to use ${_label} as a List name - it has an ambiguous plural (${_plural}). Please choose another name for your list.`
      );
    }

    this.adminUILabels = {
      label: label || _plural,
      singular: singular || _singular,
      plural: plural || _plural,
      path: path || labelToPath(_plural),
    };

    const _itemQueryName = itemQueryName || labelToClass(_singular);
    const _listQueryName = listQueryName || labelToClass(_plural);

    this.gqlNames = {
      outputTypeName: this.key,
      itemQueryName: _itemQueryName,
      listQueryName: `all${_listQueryName}`,
      listQueryMetaName: `_all${_listQueryName}Meta`,
      listMetaName: preventInvalidUnderscorePrefix(`_${_listQueryName}Meta`),
      authenticatedQueryName: `authenticated${_itemQueryName}`,
      authenticateMutationPrefix: `authenticate${_itemQueryName}`,
      unauthenticateMutationName: `unauthenticate${_itemQueryName}`,
      authenticateOutputName: `authenticate${_itemQueryName}Output`,
      unauthenticateOutputName: `unauthenticate${_itemQueryName}Output`,
      deleteMutationName: `delete${_itemQueryName}`,
      updateMutationName: `update${_itemQueryName}`,
      createMutationName: `create${_itemQueryName}`,
      deleteManyMutationName: `delete${_listQueryName}`,
      updateManyMutationName: `update${_listQueryName}`,
      createManyMutationName: `create${_listQueryName}`,
      whereInputName: `${_itemQueryName}WhereInput`,
      whereUniqueInputName: `${_itemQueryName}WhereUniqueInput`,
      updateInputName: `${_itemQueryName}UpdateInput`,
      createInputName: `${_itemQueryName}CreateInput`,
      updateManyInputName: `${_listQueryName}UpdateInput`,
      createManyInputName: `${_listQueryName}CreateInput`,
      relateToManyInputName: `${_itemQueryName}RelateToManyInput`,
      relateToOneInputName: `${_itemQueryName}RelateToOneInput`,
    };

    this.adapterName = adapter.name;
    this.adapter = adapter.newListAdapter(this.key, adapterConfig);

    this.access = parseListAccess({
      listKey: key,
      access,
      defaultAccess: this.defaultAccess.list,
    });

    this.hooksActions = {
      /**
       * @param queryString String A graphQL query string
       * @param options.skipAccessControl Boolean By default access control _of
       * the user making the initial request_ is still tested. Disable all
       * Access Control checks with this flag
       * @param options.variables Object The variables passed to the graphql
       * query for the given queryString.
       *
       * @return Promise<Object> The graphql query response
       */
      query: context => (queryString, { skipAccessControl = false, variables } = {}) => {
        let passThroughContext = context;

        if (skipAccessControl) {
          passThroughContext = {
            ...context,
            getListAccessControlForUser: () => true,
            getFieldAccessControlForUser: () => true,
          };
        }

        const graphQLQuery = getGraphQLQuery(context.schemaName);

        if (!graphQLQuery) {
          return Promise.reject(
            new Error(
              'No executable schema is available. Have you setup `@keystone-alpha/app-graphql`?'
            )
          );
        }

        return graphQLQuery(queryString, passThroughContext, variables);
      },
    };

    // Tell Keystone about all the types we've seen
    Object.values(fields).forEach(({ type }) => registerType(type));
  }

  initFields() {
    if (this.fieldsInitialised) {
      return;
    }

    this.fieldsInitialised = true;

    const sanitisedFieldsConfig = mapKeys(this._fields, (fieldConfig, path) => ({
      ...fieldConfig,
      type: mapNativeTypeToKeystoneType(fieldConfig.type, this.key, path),
    }));
    Object.values(sanitisedFieldsConfig).forEach(({ type }) => {
      if (!type.adapters[this.adapterName]) {
        throw `Adapter type "${this.adapterName}" does not support field type "${type.type}"`;
      }
    });

    this.fieldsByPath = mapKeys(
      sanitisedFieldsConfig,
      ({ type, ...fieldSpec }, path) =>
        new type.implementation(path, fieldSpec, {
          getListByKey: this.getListByKey,
          listKey: this.key,
          listAdapter: this.adapter,
          fieldAdapterClass: type.adapters[this.adapterName],
          defaultAccess: this.defaultAccess.field,
          createAuxList: this.createAuxList,
        })
    );
    this.fields = Object.values(this.fieldsByPath);
    this.views = mapKeys(sanitisedFieldsConfig, ({ type }, path) =>
      this.fieldsByPath[path].extendViews({ ...type.views })
    );
  }

  getAdminMeta() {
    return {
      key: this.key,
      // Reduce to truthy values (functions can't be passed over the webpack
      // boundary)
      access: mapKeys(this.access, val => !!val),
      label: this.adminUILabels.label,
      singular: this.adminUILabels.singular,
      plural: this.adminUILabels.plural,
      path: this.adminUILabels.path,
      gqlNames: this.gqlNames,
      fields: this.fields.filter(field => field.access.read).map(field => field.getAdminMeta()),
      views: this.views,
      adminConfig: {
        defaultPageSize: this.adminConfig.defaultPageSize,
        defaultColumns: this.adminConfig.defaultColumns.replace(/\s/g, ''), // remove all whitespace
        defaultSort: this.adminConfig.defaultSort,
        maximumPageSize: Math.max(
          this.adminConfig.defaultPageSize,
          this.adminConfig.maximumPageSize
        ),
      },
    };
  }

  getGqlTypes({ skipAccessControl = false } = {}) {
    // https://github.com/opencrud/opencrud/blob/master/spec/2-relational/2-2-queries/2-2-3-filters.md#boolean-expressions
    const types = [];
    if (
      skipAccessControl ||
      this.access.read ||
      this.access.create ||
      this.access.update ||
      this.access.delete
    ) {
      types.push(
        ...flatten(this.fields.map(field => field.getGqlAuxTypes({ skipAccessControl }))),
        `
        """ ${this.schemaDoc || 'A keystone list'} """
        type ${this.gqlNames.outputTypeName} {
          id: ID
          """
          This virtual field will be resolved in one of the following ways (in this order):
           1. Execution of 'labelResolver' set on the ${this.key} List config, or
           2. As an alias to the field set on 'labelField' in the ${this.key} List config, or
           3. As an alias to a 'name' field on the ${this.key} List (if one exists), or
           4. As an alias to the 'id' field on the ${this.key} List.
          """
          _label_: String
          ${flatten(
            this.fields
              .filter(field => skipAccessControl || field.access.read) // If it's globally set to false, makes sense to never show it
              .map(field =>
                field.schemaDoc
                  ? `""" ${field.schemaDoc} """ ${field.gqlOutputFields}`
                  : field.gqlOutputFields
              )
          ).join('\n')}
        }
      `,
        `
        input ${this.gqlNames.whereInputName} {
          id: ID
          id_not: ID
          id_in: [ID!]
          id_not_in: [ID!]

          AND: [${this.gqlNames.whereInputName}]
          OR: [${this.gqlNames.whereInputName}]

          ${flatten(
            this.fields
              .filter(field => skipAccessControl || field.access.read) // If it's globally set to false, makes sense to never show it
              .map(field => field.gqlQueryInputFields)
          ).join('\n')}
        }`,
        // TODO: Include other `unique` fields and allow filtering by them
        `
        input ${this.gqlNames.whereUniqueInputName} {
          id: ID!
        }`
      );
    }

    if (skipAccessControl || this.access.update) {
      types.push(`
        input ${this.gqlNames.updateInputName} {
          ${flatten(
            this.fields
              .filter(field => skipAccessControl || field.access.update) // If it's globally set to false, makes sense to never let it be updated
              .map(field => field.gqlUpdateInputFields)
          ).join('\n')}
        }
      `);
      types.push(`
        input ${this.gqlNames.updateManyInputName} {
          id: ID!
          data: ${this.gqlNames.updateInputName}
        }
      `);
    }

    if (skipAccessControl || this.access.create) {
      types.push(`
        input ${this.gqlNames.createInputName} {
          ${flatten(
            this.fields
              .filter(field => skipAccessControl || field.access.create) // If it's globally set to false, makes sense to never let it be created
              .map(field => field.gqlCreateInputFields)
          ).join('\n')}
        }
      `);
      types.push(`
        input ${this.gqlNames.createManyInputName} {
          data: ${this.gqlNames.createInputName}
        }
      `);
    }

    if (this.hasAuth()) {
      // If auth is enabled for this list (doesn't matter what strategy)
      types.push(`
        type ${this.gqlNames.unauthenticateOutputName} {
          """
          \`true\` when unauthentication succeeds.
          NOTE: unauthentication always succeeds when the request has an invalid or missing authentication token.
          """
          success: Boolean
        }
      `);

      types.push(`
        type ${this.gqlNames.authenticateOutputName} {
          """ Used to make subsequent authenticated requests by setting this token in a header: 'Authorization: Bearer <token>'. """
          token: String
          """ Retreive information on the newly authenticated ${
            this.gqlNames.outputTypeName
          } here. """
          item: ${this.gqlNames.outputTypeName}
        }
      `);
    }

    return types;
  }

  getGraphqlFilterFragment() {
    return [
      `where: ${this.gqlNames.whereInputName}`,
      `search: String`,
      `orderBy: String`,
      `first: Int`,
      `skip: Int`,
    ];
  }

  getGqlQueries({ skipAccessControl = false } = {}) {
    // All the auxiliary queries the fields want to add
    const queries = flatten(
      this.fields.map(field => field.getGqlAuxQueries({ skipAccessControl }))
    );

    // If `read` is either `true`, or a function (we don't care what the result
    // of the function is, that'll get executed at a later time)
    if (skipAccessControl || this.access.read) {
      queries.push(
        `
        """ Search for all ${this.gqlNames.outputTypeName} items which match the where clause. """
        ${this.gqlNames.listQueryName}(
          ${this.getGraphqlFilterFragment().join('\n')}
        ): [${this.gqlNames.outputTypeName}]`,

        `
        """ Search for the ${this.gqlNames.outputTypeName} item with the matching ID. """
        ${this.gqlNames.itemQueryName}(
          where: ${this.gqlNames.whereUniqueInputName}!
        ): ${this.gqlNames.outputTypeName}`,

        `
        """ Perform a meta-query on all ${
          this.gqlNames.outputTypeName
        } items which match the where clause. """
        ${this.gqlNames.listQueryMetaName}(
          ${this.getGraphqlFilterFragment().join('\n')}
        ): _QueryMeta`,

        `
        """ Retrieve the meta-data for the ${this.gqlNames.itemQueryName} list. """
        ${this.gqlNames.listMetaName}: _ListMeta`
      );
    }

    if (this.hasAuth()) {
      // If auth is enabled for this list (doesn't matter what strategy)
      queries.push(`${this.gqlNames.authenticatedQueryName}: ${this.gqlNames.outputTypeName}`);
    }

    return queries;
  }

  getFieldsRelatedTo(listKey) {
    return this.fields.filter(
      ({ isRelationship, refListKey }) => isRelationship && refListKey === listKey
    );
  }

  _throwAccessDenied(operation, context, target, extraInternalData = {}, extraData = {}) {
    throw new AccessDeniedError({
      data: {
        type: opToType[operation],
        target,
        ...extraData,
      },
      internalData: {
        authedId: context.authedItem && context.authedItem.id,
        authedListKey: context.authedListKey,
        ...extraInternalData,
      },
    });
  }

  // Wrap the "inner" resolver for a single output field with an access control check
  wrapFieldResolverWithAC(field, innerResolver) {
    return (item, args, context, ...rest) => {
      // If not allowed access
      const operation = 'read';
      const access = context.getFieldAccessControlForUser(this.key, field.path, item, operation);
      if (!access) {
        // If the client handles errors correctly, it should be able to
        // receive partial data (for the fields the user has access to),
        // and then an `errors` array of AccessDeniedError's
        this._throwAccessDenied(operation, context, field.path, { itemId: item ? item.id : null });
      }

      // Otherwise, execute the original/inner resolver
      return innerResolver(item, args, context, ...rest);
    };
  }

  get gqlFieldResolvers() {
    if (!this.access.read) {
      return {};
    }
    const fieldResolvers = {
      // TODO: The `_label_` output field currently circumvents access control
      _label_: this.labelResolver,
      ...objMerge(
        this.fields
          .filter(field => field.access.read)
          .map(field =>
            // Get the resolvers for the (possibly multiple) output fields and wrap each with access control
            mapKeys(field.gqlOutputFieldResolvers, innerResolver =>
              this.wrapFieldResolverWithAC(field, innerResolver)
            )
          )
      ),
    };
    return { [this.gqlNames.outputTypeName]: fieldResolvers };
  }

  get gqlAuxFieldResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge(this.fields.map(field => field.gqlAuxFieldResolvers));
  }

  get gqlAuxQueryResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge(this.fields.map(field => field.gqlAuxQueryResolvers));
  }

  get gqlAuxMutationResolvers() {
    // TODO: Obey the same ACL rules based on parent type
    return objMerge([
      ...this.mutations.map(({ schema, resolver }) => {
        const mutationName = gql(`type t { ${schema} }`).definitions[0].fields[0].name.value;
        return {
          [mutationName]: (obj, args, context, info) =>
            resolver(obj, args, context, info, mapKeys(this.hooksActions, hook => hook(context))),
        };
      }),
      ...this.fields.map(field => field.gqlAuxMutationResolvers),
    ]);
  }

  getGqlMutations({ skipAccessControl = false } = {}) {
    const mutations = flatten(
      this.fields.map(field => field.getGqlAuxMutations({ skipAccessControl }))
    );
    mutations.push(...this.mutations.map(({ schema }) => schema));

    // NOTE: We only check for truthy as it could be `true`, or a function (the
    // function is executed later in the resolver)
    if (skipAccessControl || this.access.create) {
      mutations.push(`
        """ Create a single ${this.gqlNames.outputTypeName} item. """
        ${this.gqlNames.createMutationName}(
          data: ${this.gqlNames.createInputName}
        ): ${this.gqlNames.outputTypeName}
      `);

      mutations.push(`
        """ Create multiple ${this.gqlNames.outputTypeName} items. """
        ${this.gqlNames.createManyMutationName}(
          data: [${this.gqlNames.createManyInputName}]
        ): [${this.gqlNames.outputTypeName}]
      `);
    }

    if (skipAccessControl || this.access.update) {
      mutations.push(`
      """ Update a single ${this.gqlNames.outputTypeName} item by ID. """
        ${this.gqlNames.updateMutationName}(
          id: ID!
          data: ${this.gqlNames.updateInputName}
        ): ${this.gqlNames.outputTypeName}
      `);

      mutations.push(`
      """ Update multiple ${this.gqlNames.outputTypeName} items by ID. """
        ${this.gqlNames.updateManyMutationName}(
          data: [${this.gqlNames.updateManyInputName}]
        ): [${this.gqlNames.outputTypeName}]
      `);
    }

    if (skipAccessControl || this.access.delete) {
      mutations.push(`
        """ Delete a single ${this.gqlNames.outputTypeName} item by ID. """
        ${this.gqlNames.deleteMutationName}(
          id: ID!
        ): ${this.gqlNames.outputTypeName}
      `);

      mutations.push(`
        """ Delete multiple ${this.gqlNames.outputTypeName} items by ID. """
        ${this.gqlNames.deleteManyMutationName}(
          ids: [ID!]
        ): [${this.gqlNames.outputTypeName}]
      `);
    }

    if (this.hasAuth()) {
      // If auth is enabled for this list (doesn't matter what strategy)
      mutations.push(
        `${this.gqlNames.unauthenticateMutationName}: ${this.gqlNames.unauthenticateOutputName}`
      );

      // And for each strategy, add the authentication mutation
      mutations.push(
        ...Object.entries(this.getAuth()).map(([authType, authStrategy]) => {
          const authTypeTitleCase = upcase(authType);
          return `
            """ Authenticate and generate a token for a ${
              this.gqlNames.outputTypeName
            } with the ${authTypeTitleCase} Authentication Strategy. """
            ${getAuthMutationName(this.gqlNames.authenticateMutationPrefix, authType)}(
              ${authStrategy.getInputFragment()}
            ): ${this.gqlNames.authenticateOutputName}
          `;
        })
      );
    }

    return mutations;
  }

  checkFieldAccess(operation, itemsToUpdate, context, { gqlName, extraData = {} }) {
    const restrictedFields = [];

    itemsToUpdate.forEach(({ existingItem, data }) => {
      this.fields
        .filter(field => field.path in data)
        .forEach(field => {
          const access = context.getFieldAccessControlForUser(
            this.key,
            field.path,
            existingItem,
            operation
          );
          if (!access) {
            restrictedFields.push(field.path);
          }
        });
    });
    if (restrictedFields.length) {
      this._throwAccessDenied(operation, context, gqlName, extraData, { restrictedFields });
    }
  }

  checkListAccess(context, operation, { gqlName, ...extraInternalData }) {
    const access = context.getListAccessControlForUser(this.key, operation);
    if (!access) {
      graphqlLogger.debug(
        { operation, access, gqlName, ...extraInternalData },
        'Access statically or implicitly denied'
      );
      graphqlLogger.info({ operation, gqlName, ...extraInternalData }, 'Access Denied');
      // If the client handles errors correctly, it should be able to
      // receive partial data (for the fields the user has access to),
      // and then an `errors` array of AccessDeniedError's
      this._throwAccessDenied(operation, context, gqlName, extraInternalData);
    }
    return access;
  }

  async getAccessControlledItem(id, access, { context, operation, gqlName }) {
    const throwAccessDenied = msg => {
      graphqlLogger.debug({ id, operation, access, gqlName }, msg);
      graphqlLogger.info({ id, operation, gqlName }, 'Access Denied');
      // If the client handles errors correctly, it should be able to
      // receive partial data (for the fields the user has access to),
      // and then an `errors` array of AccessDeniedError's
      this._throwAccessDenied(operation, context, gqlName, { itemId: id });
    };

    let item;
    // Early out - the user has full access to update this list
    if (access === true) {
      item = await this.adapter.findById(id);
    } else if (
      (access.id && access.id !== id) ||
      (access.id_not && access.id_not === id) ||
      (access.id_in && !access.id_in.includes(id)) ||
      (access.id_not_in && access.id_not_in.includes(id))
    ) {
      // It's odd, but conceivable the access control specifies a single id
      // the user has access to. So we have to do a check here to see if the
      // ID they're requesting matches that ID.
      // Nice side-effect: We can throw without having to ever query the DB.
      // NOTE: Don't try to early out here by doing
      // if(access.id === id) return findById(id)
      // this will result in a possible false match if a declarative access
      // control clause has other items in it
      throwAccessDenied('Item excluded this id from filters');
    } else {
      // NOTE: The fields will be filtered by the ACL checking in gqlFieldResolvers()
      // We only want 1 item, don't make the DB do extra work
      // NOTE: Order in where: { ... } doesn't matter, if `access.id !== id`, it will
      // have been caught earlier, so this spread and overwrite can only
      // ever be additive or overwrite with the same value
      item = (await this.adapter.itemsQuery({ first: 1, where: { ...access, id } }))[0];
    }
    if (!item) {
      // Throwing an AccessDenied here if the item isn't found because we're
      // strict about accidentally leaking information (that the item doesn't
      // exist)
      // NOTE: There is a potential security risk here if we were to
      // further check the existence of an item with the given ID: It'd be
      // possible to figure out if records with particular IDs exist in
      // the DB even if the user doesn't have access (eg; check a bunch of
      // IDs, and the ones that return AccessDenied exist, and the ones
      // that return null do not exist). Similar to how S3 returns 403's
      // always instead of ever returning 404's.
      // Our version is to always throw if not found.
      throwAccessDenied('Zero items found');
    }
    // Found the item, and it passed the filter test
    return item;
  }

  async getAccessControlledItems(ids, access) {
    if (ids.length === 0) {
      return [];
    }

    const uniqueIds = unique(ids);

    // Early out - the user has full access to operate on this list
    if (access === true) {
      return await this.adapter.itemsQuery({ where: { id_in: uniqueIds } });
    }

    let idFilters = {};

    if (access.id || access.id_in) {
      const accessControlIdsAllowed = unique([].concat(access.id, access.id_in).filter(id => id));

      idFilters.id_in = intersection(accessControlIdsAllowed, uniqueIds);
    } else {
      idFilters.id_in = uniqueIds;
    }

    if (access.id_not || access.id_not_in) {
      const accessControlIdsDisallowed = unique(
        [].concat(access.id_not, access.id_not_in).filter(id => id)
      );

      idFilters.id_not_in = intersection(accessControlIdsDisallowed, uniqueIds);
    }

    // It's odd, but conceivable the access control specifies a single id
    // the user has access to. So we have to do a check here to see if the
    // ID they're requesting matches that ID.
    // Nice side-effect: We can throw without having to ever query the DB.
    // NOTE: Don't try to early out here by doing
    // if(access.id === id) return findById(id)
    // this will result in a possible false match if the access control
    // has other items in it
    if (
      // Only some ids are allowed, and none of them have been passed in
      (idFilters.id_in && idFilters.id_in.length === 0) ||
      // All the passed in ids have been explicitly disallowed
      (idFilters.id_not_in && idFilters.id_not_in.length === uniqueIds.length)
    ) {
      // NOTE: We don't throw an error for multi-actions, only return an empty
      // array because there's no mechanism in GraphQL to return more than one
      // error for a list result.
      return [];
    }

    // NOTE: The fields will be filtered by the ACL checking in gqlFieldResolvers()
    // NOTE: Unlike in the single-operation variation, there is no security risk
    // in returning the result of the query here, because if no items match, we
    // return an empty array regarless of if that's because of lack of
    // permissions or because of those items don't exist.
    const remainingAccess = omit(access, ['id', 'id_not', 'id_in', 'id_not_in']);
    return await this.adapter.itemsQuery({ where: { ...remainingAccess, ...idFilters } });
  }

  get gqlQueryResolvers() {
    let resolvers = {};

    // If set to false, we can confidently remove these resolvers entirely from
    // the graphql schema
    if (this.access.read) {
      resolvers = {
        [this.gqlNames.listQueryName]: (_, args, context) =>
          this.listQuery(args, context, this.gqlNames.listQueryName),

        [this.gqlNames.listQueryMetaName]: (_, args, context) =>
          this.listQueryMeta(args, context, this.gqlNames.listQueryMetaName),

        [this.gqlNames.listMetaName]: (_, args, context) => this.listMeta(context),

        [this.gqlNames.itemQueryName]: (_, args, context) =>
          this.itemQuery(args, context, this.gqlNames.itemQueryName),
      };
    }

    // NOTE: This query is not effected by the read permissions; if the user can
    // authenticate themselves, then they already have access to know that the
    // list exists
    if (this.hasAuth()) {
      resolvers[this.gqlNames.authenticatedQueryName] = (_, __, context) =>
        this.authenticatedQuery(context);
    }

    return resolvers;
  }

  async listQuery(args, context, queryName) {
    const access = this.checkListAccess(context, 'read', { queryName });

    return this.adapter.itemsQuery(mergeWhereClause(args, access));
  }

  async listQueryMeta(args, context, queryName) {
    return {
      // Return these as functions so they're lazily evaluated depending
      // on what the user requested
      // Evalutation takes place in ../Keystone/index.js
      getCount: () => {
        const access = this.checkListAccess(context, 'read', { queryName });

        return this.adapter
          .itemsQueryMeta(mergeWhereClause(args, access))
          .then(({ count }) => count);
      },
    };
  }

  listMeta(context) {
    return {
      name: this.key,
      // Return these as functions so they're lazily evaluated depending
      // on what the user requested
      // Evalutation takes place in ../Keystone/index.js
      // NOTE: These could return a Boolean or a JSON object (if using the
      // declarative syntax)
      getAccess: () => ({
        getCreate: () => context.getListAccessControlForUser(this.key, 'create'),
        getRead: () => context.getListAccessControlForUser(this.key, 'read'),
        getUpdate: () => context.getListAccessControlForUser(this.key, 'update'),
        getDelete: () => context.getListAccessControlForUser(this.key, 'delete'),
      }),
      getSchema: () => {
        const queries = [
          this.gqlNames.itemQueryName,
          this.gqlNames.listQueryName,
          this.gqlNames.listQueryMetaName,
        ];

        if (this.hasAuth()) {
          queries.push(this.gqlNames.authenticatedQueryName);
        }

        // NOTE: Other fields on this type are resolved in the main resolver in
        // ../Keystone/index.js
        return {
          type: this.gqlNames.outputTypeName,
          queries,
          key: this.key,
        };
      },
    };
  }

  async itemQuery(
    // prettier-ignore
    { where: { id } },
    context,
    gqlName
  ) {
    const operation = 'read';
    graphqlLogger.debug({ id, operation, type: opToType[operation], gqlName }, 'Start query');

    const access = this.checkListAccess(context, operation, { gqlName, itemId: id });

    const result = await this.getAccessControlledItem(id, access, { context, operation, gqlName });

    graphqlLogger.debug({ id, operation, type: opToType[operation], gqlName }, 'End query');
    return result;
  }

  authenticatedQuery(context) {
    if (!context.authedItem || context.authedListKey !== this.key) {
      return null;
    }

    return this.itemQuery(
      { where: { id: context.authedItem.id } },
      context,
      this.gqlNames.authenticatedQueryName
    );
  }

  async authenticateMutation(authType, args, context) {
    // This is currently hard coded to enable authenticating with the admin UI.
    // In the near future we will set up the admin-ui application and api to be
    // non-public.
    const audiences = ['admin'];

    const authStrategy = this.getAuth()[authType];

    // Verify incoming details
    const { item, success, message } = await authStrategy.validate(args);

    if (!success) {
      throw new Error(message);
    }

    const token = await context.startAuthedSession({ item, list: this }, audiences);
    return {
      token,
      item,
    };
  }

  async unauthenticateMutation(context) {
    await context.endAuthedSession();
    return { success: true };
  }

  get gqlMutationResolvers() {
    const mutationResolvers = {};

    if (this.access.create) {
      mutationResolvers[this.gqlNames.createMutationName] = (_, { data }, context) =>
        this.createMutation(data, context);

      mutationResolvers[this.gqlNames.createManyMutationName] = (_, { data }, context) =>
        this.createManyMutation(data, context);
    }

    if (this.access.update) {
      mutationResolvers[this.gqlNames.updateMutationName] = (_, { id, data }, context) =>
        this.updateMutation(id, data, context);

      mutationResolvers[this.gqlNames.updateManyMutationName] = (_, { data }, context) =>
        this.updateManyMutation(data, context);
    }

    if (this.access.delete) {
      mutationResolvers[this.gqlNames.deleteMutationName] = (_, { id }, context) =>
        this.deleteMutation(id, context);

      mutationResolvers[this.gqlNames.deleteManyMutationName] = (_, { ids }, context) =>
        this.deleteManyMutation(ids, context);
    }

    // NOTE: This query is not effected by the read permissions; if the user can
    // authenticate themselves, then they already have access to know that the
    // list exists
    if (this.hasAuth()) {
      mutationResolvers[this.gqlNames.unauthenticateMutationName] = (_, __, context) =>
        this.unauthenticateMutation(context);

      Object.keys(this.getAuth()).forEach(authType => {
        mutationResolvers[
          getAuthMutationName(this.gqlNames.authenticateMutationPrefix, authType)
        ] = (_, args, context) => this.authenticateMutation(authType, args, context);
      });
    }

    return mutationResolvers;
  }

  _throwValidationFailure(errors, operation, data = {}) {
    throw new ValidationFailureError({
      data: {
        messages: errors.map(e => e.msg),
        errors: errors.map(e => e.data),
        listKey: this.key,
        operation,
      },
      internalData: {
        errors: errors.map(e => e.internalData),
        data,
      },
    });
  }

  _mapToFields(fields, action) {
    return resolveAllKeys(arrayToObject(fields, 'path', action)).catch(error => {
      if (!error.errors) {
        throw error;
      }
      const errorCopy = new Error(error.message || error.toString());
      errorCopy.errors = Object.values(error.errors);
      throw errorCopy;
    });
  }

  _fieldsFromObject(obj) {
    return Object.keys(obj)
      .map(fieldPath => this.fieldsByPath[fieldPath])
      .filter(field => field);
  }

  async _resolveRelationship(data, existingItem, context, getItem, mutationState) {
    const fields = this._fieldsFromObject(data).filter(field => field.isRelationship);
    const resolvedRelationships = await this._mapToFields(fields, async field => {
      const operations = await field.resolveNestedOperations(
        data[field.path],
        existingItem,
        context,
        getItem,
        mutationState
      );
      return field.convertResolvedOperationsToFieldValue(operations, existingItem);
    });

    return {
      ...data,
      ...resolvedRelationships,
    };
  }

  async _registerBacklinks(existingItem, mutationState) {
    const fields = this.fields.filter(field => field.isRelationship);
    await this._mapToFields(fields, field =>
      field.registerBacklink(existingItem[field.path], existingItem, mutationState)
    );
  }

  async _resolveDefaults(data) {
    // FIXME: Consider doing this in a way which only calls getDefaultValue once.
    const fields = this.fields.filter(field => field.getDefaultValue() !== undefined);
    return {
      ...(await this._mapToFields(fields, field => field.getDefaultValue())),
      ...data,
    };
  }

  async _resolveInput(resolvedData, existingItem, context, operation, originalInput) {
    const args = {
      resolvedData,
      existingItem,
      context,
      originalInput,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    const fields = this._fieldsFromObject(resolvedData);

    resolvedData = await this._mapToFields(fields, field =>
      field.resolveInput({ resolvedData, ...args })
    );
    resolvedData = {
      ...resolvedData,
      ...(await this._mapToFields(fields.filter(field => field.hooks.resolveInput), field =>
        field.hooks.resolveInput({ resolvedData, ...args })
      )),
    };

    if (this.hooks.resolveInput) {
      resolvedData = await this.hooks.resolveInput({ resolvedData, ...args });
    }

    return resolvedData;
  }

  async _validateInput(resolvedData, existingItem, context, operation, originalInput) {
    const args = {
      resolvedData,
      existingItem,
      context,
      originalInput,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    // Check for isRequired
    const fieldValidationErrors = this.fields
      .filter(
        field =>
          field.isRequired &&
          !field.isRelationship &&
          ((operation === 'create' &&
            (resolvedData[field.path] === undefined || resolvedData[field.path] === null)) ||
            (operation === 'update' &&
              Object.prototype.hasOwnProperty.call(resolvedData, field.path) &&
              (resolvedData[field.path] === undefined || resolvedData[field.path] === null)))
      )
      .map(f => ({
        msg: `Required field "${f.path}" is null or undefined.`,
        data: { resolvedData, operation, originalInput },
        internalData: {},
      }));
    if (fieldValidationErrors.length) {
      this._throwValidationFailure(fieldValidationErrors, operation, originalInput);
    }

    const fields = this._fieldsFromObject(resolvedData);
    await this._validateHook(args, fields, operation, 'validateInput');
  }

  async _validateDelete(existingItem, context, operation) {
    const args = {
      existingItem,
      context,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    const fields = this.fields;
    await this._validateHook(args, fields, operation, 'validateDelete');
  }

  async _validateHook(args, fields, operation, hookName) {
    const { originalInput } = args;
    const fieldValidationErrors = [];
    // FIXME: Can we do this in a way where we simply return validation errors instead?
    args.addFieldValidationError = (msg, _data = {}, internalData = {}) =>
      fieldValidationErrors.push({ msg, data: _data, internalData });
    await this._mapToFields(fields, field => field[hookName](args));
    await this._mapToFields(fields.filter(field => field.hooks[hookName]), field =>
      field.hooks[hookName](args)
    );
    if (fieldValidationErrors.length) {
      this._throwValidationFailure(fieldValidationErrors, operation, originalInput);
    }

    if (this.hooks[hookName]) {
      const listValidationErrors = [];
      await this.hooks[hookName]({
        ...args,
        addValidationError: (msg, _data = {}, internalData = {}) =>
          listValidationErrors.push({ msg, data: _data, internalData }),
      });
      if (listValidationErrors.length) {
        this._throwValidationFailure(listValidationErrors, operation, originalInput);
      }
    }
  }

  async _beforeChange(resolvedData, existingItem, context, originalInput) {
    const args = {
      resolvedData,
      existingItem,
      context,
      originalInput,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    await this._runHook(args, resolvedData, 'beforeChange');
  }

  async _beforeDelete(existingItem, context) {
    const args = {
      existingItem,
      context,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    await this._runHook(args, existingItem, 'beforeDelete');
  }

  async _afterChange(updatedItem, existingItem, context, originalInput) {
    const args = {
      updatedItem,
      originalInput,
      existingItem,
      context,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    await this._runHook(args, updatedItem, 'afterChange');
  }

  async _afterDelete(existingItem, context) {
    const args = {
      existingItem,
      context,
      actions: mapKeys(this.hooksActions, hook => hook(context)),
    };
    await this._runHook(args, existingItem, 'afterDelete');
  }

  async _runHook(args, fieldObject, hookName) {
    const fields = this._fieldsFromObject(fieldObject);
    await this._mapToFields(fields, field => field[hookName](args));
    await this._mapToFields(fields.filter(field => field.hooks[hookName]), field =>
      field.hooks[hookName](args)
    );

    if (this.hooks[hookName]) await this.hooks[hookName](args);
  }

  async _nestedMutation(mutationState, context, mutation) {
    const { Relationship } = require('@keystone-alpha/fields');
    // Set up a fresh mutation state if we're the root mutation
    const isRootMutation = !mutationState;
    if (isRootMutation) {
      mutationState = {
        afterChangeStack: [], // post-hook stack
        queues: {}, // backlink queues
        transaction: {}, // transaction
      };
    }

    // Perform the mutation
    const { result, afterHook } = await mutation(mutationState);

    // resolve backlinks
    await Relationship.resolveBacklinks(context, mutationState);

    // Push after-hook onto the stack and resolve all if we're the root.
    const { afterChangeStack } = mutationState;
    afterChangeStack.push(afterHook);
    if (isRootMutation) {
      // TODO: Close transaction

      // Execute post-hook stack
      while (afterChangeStack.length) {
        await afterChangeStack.pop()();
      }
    }

    // Return the result of the mutation
    return result;
  }

  async createMutation(data, context, mutationState) {
    const operation = 'create';
    const gqlName = this.gqlNames.createMutationName;

    this.checkListAccess(context, operation, { gqlName });

    const existingItem = undefined;

    const itemsToUpdate = [{ existingItem, data }];

    this.checkFieldAccess(operation, itemsToUpdate, context, { gqlName });

    return await this._createSingle(data, existingItem, context, mutationState);
  }

  async createManyMutation(data, context, mutationState) {
    const operation = 'create';
    const gqlName = this.gqlNames.createManyMutationName;

    this.checkListAccess(context, operation, { gqlName });

    const itemsToUpdate = data.map(d => ({ existingItem: undefined, data: d.data }));

    this.checkFieldAccess(operation, itemsToUpdate, context, { gqlName });

    return Promise.all(
      data.map(d => this._createSingle(d.data, undefined, context, mutationState))
    );
  }

  async _createSingle(data, existingItem, context, mutationState) {
    const operation = 'create';
    return await this._nestedMutation(mutationState, context, async mutationState => {
      const defaultedItem = await this._resolveDefaults(data);

      // Enable resolveRelationship to perform some action after the item is created by
      // giving them a promise which will eventually resolve with the value of the
      // newly created item.
      const createdPromise = createLazyDeferred();

      let resolvedData = await this._resolveRelationship(
        defaultedItem,
        existingItem,
        context,
        createdPromise.promise,
        mutationState
      );

      resolvedData = await this._resolveInput(resolvedData, existingItem, context, operation, data);

      await this._validateInput(resolvedData, existingItem, context, operation, data);

      await this._beforeChange(resolvedData, existingItem, context, operation, data);

      let newItem;
      try {
        newItem = await this.adapter.create(resolvedData);
        createdPromise.resolve(newItem);
        // Wait until next tick so the promise/micro-task queue can be flushed
        // fully, ensuring the deferred handlers get executed before we move on
        await new Promise(res => process.nextTick(res));
      } catch (error) {
        createdPromise.reject(error);
        // Wait until next tick so the promise/micro-task queue can be flushed
        // fully, ensuring the deferred handlers get executed before we move on
        await new Promise(res => process.nextTick(res));
        // Rethrow the error to ensure it's surfaced to Apollo
        throw error;
      }

      return {
        result: newItem,
        afterHook: () => this._afterChange(newItem, existingItem, context, operation, data),
      };
    });
  }

  async updateMutation(id, data, context, mutationState) {
    const operation = 'update';
    const gqlName = this.gqlNames.updateMutationName;
    const extraData = { itemId: id };

    const access = this.checkListAccess(context, operation, { gqlName, ...extraData });

    const existingItem = await this.getAccessControlledItem(id, access, {
      context,
      operation,
      gqlName,
    });

    const itemsToUpdate = [{ existingItem, data }];

    this.checkFieldAccess(operation, itemsToUpdate, context, { gqlName, extraData });

    return await this._updateSingle(id, data, existingItem, context, mutationState);
  }

  async updateManyMutation(data, context, mutationState) {
    const operation = 'update';
    const gqlName = this.gqlNames.updateManyMutationName;
    const ids = data.map(d => d.id);
    const extraData = { itemId: ids };

    const access = this.checkListAccess(context, operation, { gqlName, ...extraData });

    const existingItems = await this.getAccessControlledItems(ids, access);

    const itemsToUpdate = zipObj({
      existingItem: existingItems,
      id: ids,
      data: data.map(d => d.data),
    });

    // FIXME: We should do all of these in parallel and return *all* the field access violations
    this.checkFieldAccess(operation, itemsToUpdate, context, { gqlName, extraData });

    return Promise.all(
      itemsToUpdate.map(({ existingItem, id, data }) =>
        this._updateSingle(id, data, existingItem, context, mutationState)
      )
    );
  }

  async _updateSingle(id, data, existingItem, context, mutationState) {
    const operation = 'update';
    return await this._nestedMutation(mutationState, context, async mutationState => {
      let resolvedData = await this._resolveRelationship(
        data,
        existingItem,
        context,
        undefined,
        mutationState
      );

      resolvedData = await this._resolveInput(resolvedData, existingItem, context, operation, data);

      await this._validateInput(resolvedData, existingItem, context, operation, data);

      await this._beforeChange(resolvedData, existingItem, context, operation, data);

      const newItem = await this.adapter.update(id, resolvedData);

      return {
        result: newItem,
        afterHook: () => this._afterChange(newItem, existingItem, context, operation, data),
      };
    });
  }

  async deleteMutation(id, context, mutationState) {
    const operation = 'delete';
    const gqlName = this.gqlNames.deleteMutationName;

    const access = this.checkListAccess(context, operation, { gqlName, itemId: id });

    const existingItem = await this.getAccessControlledItem(id, access, {
      context,
      operation,
      gqlName,
    });

    return this._deleteSingle(existingItem, context, mutationState);
  }

  async deleteManyMutation(ids, context, mutationState) {
    const operation = 'delete';
    const gqlName = this.gqlNames.deleteManyMutationName;

    const access = this.checkListAccess(context, operation, { gqlName, itemIds: ids });

    const existingItems = await this.getAccessControlledItems(ids, access);

    return Promise.all(
      existingItems.map(existingItem => this._deleteSingle(existingItem, context, mutationState))
    );
  }

  async _deleteSingle(existingItem, context, mutationState) {
    const operation = 'delete';

    return await this._nestedMutation(mutationState, context, async mutationState => {
      await this._registerBacklinks(existingItem, mutationState);

      await this._validateDelete(existingItem, context, operation);

      await this._beforeDelete(existingItem, context);

      const result = await this.adapter.delete(existingItem.id);

      return {
        result,
        afterHook: () => this._afterDelete(existingItem, context),
      };
    });
  }

  getFieldByPath(path) {
    return this.fieldsByPath[path];
  }
};

const { Keystone } = require('@keystone-alpha/keystone');
const {
  File,
  Text,
  Integer,
  Relationship,
  Select,
  Password,
  Checkbox,
  CalendarDay,
  CloudinaryImage,
  DateTime,
  Color,
  Url,
  Content,
  Decimal,
  OEmbed,
} = require('@keystone-alpha/fields');
const { CloudinaryAdapter, LocalFileAdapter } = require('@keystone-alpha/file-adapters');
const { GraphQLApp } = require('@keystone-alpha/app-graphql');
const { AdminUIApp } = require('@keystone-alpha/app-admin-ui');
const { StaticApp } = require('@keystone-alpha/app-static');
const { graphql } = require('graphql');

const { staticRoute, staticPath, cloudinary } = require('./config');
const MockOEmbedAdapter = require('./mocks/oembed-adapter');

const LOCAL_FILE_PATH = `${staticPath}/avatars`;
const LOCAL_FILE_ROUTE = `${staticRoute}/avatars`;

const Stars = require('./custom-fields/Stars');
const getYear = require('date-fns/get_year');

// TODO: Make this work again
// const SecurePassword = require('./custom-fields/SecurePassword');

const { MongooseAdapter } = require('@keystone-alpha/adapter-mongoose');

const keystone = new Keystone({
  name: 'Cypress Test Project Basic',
  adapter: new MongooseAdapter(),
});

const fileAdapter = new LocalFileAdapter({
  directory: LOCAL_FILE_PATH,
  route: LOCAL_FILE_ROUTE,
});

let cloudinaryAdapter;
try {
  cloudinaryAdapter = new CloudinaryAdapter({
    ...cloudinary,
    folder: 'avatars',
  });
} catch (e) {
  // Downgrade from an error to a warning if the dev does not have a
  // Cloudinary API Key set up. This will disable any fields which rely
  // on this functionality.
  console.warn(e.message);
}

keystone.createList('User', {
  fields: {
    name: { type: Text },
    email: { type: Text, isUnique: true },
    dob: {
      type: CalendarDay,
      format: 'Do MMMM YYYY',
      yearRangeFrom: 1901,
      yearRangeTo: getYear(new Date()),
    },
    lastOnline: {
      type: DateTime,
      format: 'MM/DD/YYYY h:mm A',
      yearRangeFrom: 2013,
    },
    password: { type: Password },
    isAdmin: { type: Checkbox },
    favouritePosts: { type: Relationship, ref: 'Post', many: true },
    company: {
      type: Select,
      options: [
        { label: 'Thinkmill', value: 'thinkmill' },
        { label: 'Atlassian', value: 'atlassian' },
        { label: 'Thomas Walker Gelato', value: 'gelato' },
        { label: 'Cete, or Seat, or Attend ¯\\_(ツ)_/¯', value: 'cete' },
      ],
    },
    attachment: { type: File, adapter: fileAdapter },
    color: { type: Color },
    website: { type: Url },
    profile: { type: OEmbed, adapter: new MockOEmbedAdapter() },
    ...(cloudinaryAdapter ? { avatar: { type: CloudinaryImage, adapter: cloudinaryAdapter } } : {}),
  },
  labelResolver: item => `${item.name} <${item.email}>`,
  hooks: {
    validateInput: async ({ resolvedData, addValidationError }) => {
      if (resolvedData.name === 'Homer') {
        addValidationError('Sorry, no Homers allowed', { a: 1 }, { b: 2 });
      }
    },
  },
});

keystone.createList('Post', {
  fields: {
    name: { type: Text },
    slug: { type: Text },
    status: {
      type: Select,
      defaultValue: 'draft',
      options: [{ label: 'Draft', value: 'draft' }, { label: 'Published', value: 'published' }],
    },
    author: {
      type: Relationship,
      ref: 'User',
    },
    categories: {
      type: Relationship,
      ref: 'PostCategory',
      many: true,
    },
    stars: { type: Stars, starCount: 5 },
    views: { type: Integer },
    price: { type: Decimal, symbol: '$' },
    currency: { type: Text },
    hero: { type: File, adapter: fileAdapter },
    value: {
      type: Content,
      blocks: [
        [CloudinaryImage.blocks.image, { adapter: cloudinaryAdapter }],
        Content.blocks.blockquote,
        Content.blocks.orderedList,
        Content.blocks.unorderedList,
        [Content.blocks.embed, { apiKey: process.env.EMBEDLY_API_KEY }],
        Content.blocks.link,
        Content.blocks.heading,
      ],
    },
  },
  adminConfig: {
    defaultPageSize: 20,
    defaultColumns: 'name, status',
    defaultSort: 'name',
  },
  labelResolver: async (item, args, context, { schema }) => {
    if (item.author) {
      const query = `
        query getAuthor($authorId: ID!) {
          User(where: { id: $authorId }) {
            name
          }
        }
      `;
      const variables = { authorId: item.author.toString() };
      const { data } = await graphql(schema, query, null, context, variables);
      return `${item.name} (by ${data.User.name})`;
    } else {
      return item.name;
    }
  },
});

keystone.createList('PostCategory', {
  fields: {
    name: { type: Text },
    slug: { type: Text },
  },
});

keystone.createList('SomeLongNamedList', {
  fields: {
    name: { type: Text },
  },
});

module.exports = {
  keystone,
  apps: [
    new GraphQLApp(),
    new StaticApp({ path: staticRoute, src: staticPath }),
    new AdminUIApp({ enableDefaultRoute: true }),
  ],
};

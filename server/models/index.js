import sequelizePkg from 'sequelize';
import { config } from '../config/index.js';
import UserFactory from './User.js';
import CategoryFactory from './Category.js';
import NovelFactory from './Novel.js';
import ChapterFactory from './Chapter.js';
import BookshelfFactory from './Bookshelf.js';

const { Sequelize } = sequelizePkg;

export const sequelize = new Sequelize(config.db.name, config.db.user, config.db.pass, {
  host: config.db.host,
  port: config.db.port,
  dialect: 'mysql',
  dialectOptions: { charset: 'utf8mb4' },
  charset: 'utf8mb4',
  collate: config.db.collate,
  logging: false,
  timezone: '+08:00',
  define: { charset: 'utf8mb4', collate: config.db.collate },
});

const User = UserFactory(sequelize);
const Category = CategoryFactory(sequelize);
const Novel = NovelFactory(sequelize);
const Chapter = ChapterFactory(sequelize);
const Bookshelf = BookshelfFactory(sequelize);

// 关联
Novel.belongsTo(Category, { foreignKey: 'categoryId', as: 'category' });
Category.hasMany(Novel, { foreignKey: 'categoryId', as: 'novels' });

Novel.hasMany(Chapter, { foreignKey: 'novelId', as: 'chapters' });
Chapter.belongsTo(Novel, { foreignKey: 'novelId', as: 'novel' });

User.hasMany(Bookshelf, { foreignKey: 'userId', as: 'bookshelves' });
Bookshelf.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Bookshelf.belongsTo(Novel, { foreignKey: 'novelId', as: 'novel' });
Novel.hasMany(Bookshelf, { foreignKey: 'novelId', as: 'bookshelfEntries' });

export { User, Category, Novel, Chapter, Bookshelf };
export default sequelize;

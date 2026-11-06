import sequelizePkg from 'sequelize';

const { DataTypes } = sequelizePkg;

export default (sequelize) =>
  sequelize.define('Bookshelf', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    novelId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    lastChapterId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: '最近阅读章节ID' },
    lastPosition: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0, comment: '章节内滚动百分比 0-100' },
    lastReadTime: { type: DataTypes.DATE, allowNull: true },
  }, {
    tableName: 'bookshelves',
    underscored: true,
    indexes: [
      { unique: true, fields: ['user_id', 'novel_id'], name: 'uq_user_novel' },
    ],
  });

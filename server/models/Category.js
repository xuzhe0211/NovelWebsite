import sequelizePkg from 'sequelize';

const { DataTypes } = sequelizePkg;

export default (sequelize) =>
  sequelize.define('Category', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(32), allowNull: false, comment: '分类名（简体）' },
    slug: { type: DataTypes.STRING(32), allowNull: false, unique: true, comment: '英文标识' },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'categories',
    underscored: true,
  });

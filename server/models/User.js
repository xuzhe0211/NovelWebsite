import sequelizePkg from 'sequelize';

const { DataTypes } = sequelizePkg;

export default (sequelize) =>
  sequelize.define('User', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    openid: { type: DataTypes.STRING(64), allowNull: false, unique: true, comment: '微信 openid' },
    nickname: { type: DataTypes.STRING(64), allowNull: true },
    avatar: { type: DataTypes.STRING(512), allowNull: true },
  }, {
    tableName: 'users',
    underscored: true,
  });

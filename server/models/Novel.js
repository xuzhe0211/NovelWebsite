import sequelizePkg from 'sequelize';

const { DataTypes } = sequelizePkg;

export default (sequelize) =>
  sequelize.define('Novel', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    sourceId: { type: DataTypes.STRING(64), allowNull: false, unique: true, comment: '站点小说ID（twkan /txt/{id}/ 路径段）' },
    sourceUrl: { type: DataTypes.STRING(512), allowNull: true, comment: '源站书籍页链接，供后续继续补章' },
    title: { type: DataTypes.STRING(128), allowNull: false, comment: '书名（简体）' },
    author: { type: DataTypes.STRING(64), allowNull: true, comment: '作者（简体）' },
    categoryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    coverUrl: { type: DataTypes.STRING(512), allowNull: true, comment: '封面图，防盗链时存本地相对路径' },
    intro: { type: DataTypes.TEXT, allowNull: true, comment: '简介（简体）' },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: '连载中', comment: '连载中/完结' },
    isCompleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastChapterId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, comment: '最新章节ID' },
    lastChapterTitle: { type: DataTypes.STRING(128), allowNull: true },
    wordCount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, comment: '总字数' },
    clickCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    rating: { type: DataTypes.DECIMAL(3, 1), allowNull: false, defaultValue: 0 },
    lastUpdateTime: { type: DataTypes.DATE, allowNull: true, comment: '站点最后更新时间' },
  }, {
    tableName: 'novels',
    underscored: true,
  });

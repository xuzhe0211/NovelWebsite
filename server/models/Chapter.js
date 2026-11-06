import sequelizePkg from 'sequelize';

const { DataTypes } = sequelizePkg;

export default (sequelize) =>
  sequelize.define('Chapter', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    novelId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    sourceChapterId: { type: DataTypes.STRING(64), allowNull: false, comment: '站点章节ID' },
    chapterNo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, comment: '章节序号，用于排序/上一章/下一章' },
    title: { type: DataTypes.STRING(128), allowNull: false, comment: '章节名（简体）' },
    content: { type: DataTypes.TEXT('long'), allowNull: true, comment: '正文（简体），段落以 \\n 分隔' },
    wordCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  }, {
    tableName: 'chapters',
    underscored: true,
    indexes: [
      { unique: true, fields: ['novel_id', 'source_chapter_id'], name: 'uq_novel_src_chapter' },
      // chapterNo 仅用于排序，不设唯一（增量抓取时序号可能重排）
      { fields: ['novel_id', 'chapter_no'], name: 'idx_novel_chapter_no' },
    ],
  });

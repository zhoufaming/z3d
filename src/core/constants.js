/**
 * 全局常量：把散落在各文件中的「魔法值」集中管理，便于统一维护。
 */

/** AI 控制桥本地服务端口（main 进程启动，token 鉴权） */
export const PORT_AI = 5199;

/** 静态文件服务端口（Electron 套壳托管构建产物） */
export const PORT_STATIC = 5188;

/** 默认热床尺寸（mm），与 PRINTER_PRESETS 中的 'auto' 一致 */
export const DEFAULT_BED = { width: 256, depth: 256, height: 256 };

/** 顶点焊接 / 连通性判定容差（mm） */
export const WELD_TOLERANCE = 1e-3;

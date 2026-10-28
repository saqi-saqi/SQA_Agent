/**
 * Structured JSON logger — replaces the stub with qagent's production logger.
 *
 * Outputs newline-delimited JSON to stdout/stderr. Supports LOG_LEVEL filtering.
 * Exported API: { debug, info, warn, error } — each is (msg, data?) => void.
 */

const getLevelInt = (level) => {
  switch (level?.toLowerCase()) {
    case 'debug': return 10;
    case 'info':  return 20;
    case 'warn':  return 30;
    case 'error': return 40;
    default:      return 20;
  }
};

const currentLevelInt = getLevelInt(process.env.LOG_LEVEL || process.env.SQA_LOG_LEVEL || 'info');

const log = (level, msg, data) => {
  const msgLevelInt = getLevelInt(level);
  if (msgLevelInt < currentLevelInt) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message: msg,
    ...(data !== undefined && { data }),
  };

  const jsonStr = JSON.stringify(logEntry);

  switch (level) {
    case 'debug':
    case 'info':
      console.log(jsonStr);
      break;
    case 'warn':
      console.warn(jsonStr);
      break;
    case 'error':
      console.error(jsonStr);
      break;
  }
};

export const debug = (msg, data) => log('debug', msg, data);
export const info  = (msg, data) => log('info',  msg, data);
export const warn  = (msg, data) => log('warn',  msg, data);
export const error = (msg, data) => log('error', msg, data);

export default { debug, info, warn, error };

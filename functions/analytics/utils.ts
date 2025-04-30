import {createHash} from 'crypto';

// don't log in production
const LOG = true; process.env.SST_STAGE === 'lefnire'
export function log (...args) {
  if (!LOG) {return;}
  console.log(...args)
}

// someday maybe use for cross-session (non-compliant), but not tracking for now
// see https://www.goatcounter.com/help/sessions
function myCreateHash(data) {
  const hash = createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}
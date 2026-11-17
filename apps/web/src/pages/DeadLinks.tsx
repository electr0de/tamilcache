import { Unresolved } from './Unresolved.js';

/**
 * The dead-link view: the same queue filtered to `gone`. One implementation, two entry points —
 * a 404 lands here, and the recheck action lives on the row it belongs to.
 */
export function DeadLinks() {
  return <Unresolved fixedStatus="gone" />;
}

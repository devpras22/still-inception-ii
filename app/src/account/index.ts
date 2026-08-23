/**
 * Account — the hosted plan, usage and key, for people who use the hosted path.
 *
 * Belongs here: anything about the hosted account itself.
 * Belongs elsewhere: the key's effect on which store or provider is chosen,
 * which is the provider registry's decision, not this domain's.
 *
 * Nothing here is fetched until a key is configured. This surface used to call
 * the hosted API on its first click with no key at all and then blame the user
 * for a key they had never entered.
 */
export { Account } from './Account'

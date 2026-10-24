import assert from 'node:assert/strict';
export {expectValue,publicEcJwk} from './assertions.mjs';
function assertRecord(value:unknown):asserts value is Record<string,unknown>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));}
function object(value:unknown):Record<string,unknown>{assertRecord(value);return value;}
function text(value:unknown):string{assert.equal(typeof value,'string');assert.ok(typeof value==='string');return value;}
function strings(value:unknown):string[]{assert.ok(Array.isArray(value));return value.map(text);}
// Validate fields at the JSON/process boundary when an assertion reads them. CLI result
// shapes differ by command; absent fields fail rather than receive invented defaults.
export function result(value:unknown){const row=object(value);return {toJSON(){return row;},
 get status(){return text(row.status);},
 get connection(){const c=object(row.connection);return {status:text(c.status)};},
 get outcome(){const o=object(row.outcome);return {get status(){return text(o.status);},get operationId(){return text(o.operationId);}};},
 get authorizationUrl(){return text(row.authorizationUrl);},
 get device(){return {userCode:text(object(row.device).userCode)};},
 get sufficient(){assert.equal(typeof row.sufficient,'boolean');return row.sufficient;},
 get grantedScopes(){return strings(row.grantedScopes);},get missingScopes(){return strings(row.missingScopes);},
 get delivery(){return text(row.delivery);},get cursor(){assert.ok(row.cursor===null||typeof row.cursor==='string');return row.cursor;},
 get events(){assert.ok(Array.isArray(row.events));return row.events;},
 get methods(){assert.ok(Array.isArray(row.methods));return row.methods.map(m=>({method:text(object(m).method)}));},
 };}
export function reply(value:unknown){const row=object(value);return {toJSON(){return row;},get status(){return text(row.status);},get result(){return result(row.result);},get error(){return {code:text(object(row.error).code),get requiredScopes(){return strings(object(row.error).requiredScopes);}};}};}

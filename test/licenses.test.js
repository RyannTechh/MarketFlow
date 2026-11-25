import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseSecret, encryptLicense, decryptLicense, licenseHash } from '../src/licenses.js';
const key=licenseSecret('ab'.repeat(32));
test('license encryption is randomized and reversible',()=>{
 const value='MF-'+ 'cd'.repeat(24);
 const a=encryptLicense(value,key),b=encryptLicense(value,key);
 assert.notEqual(a,b);assert.ok(!a.includes(value));assert.equal(decryptLicense(a,key),value);assert.equal(decryptLicense(b,key),value);
 assert.equal(licenseHash(value).length,64);
});
test('incorrect keys and tampered ciphertext fail authentication',()=>{
 const enc=encryptLicense('secret',key);
 assert.throws(()=>decryptLicense(enc,licenseSecret('12'.repeat(32))));
 const [iv,tag,data]=enc.split('.');const changed=(data[0]==='a'?'b':'a')+data.slice(1);
 assert.throws(()=>decryptLicense([iv,tag,changed].join('.'),key));
 assert.throws(()=>licenseSecret('bad'));
});

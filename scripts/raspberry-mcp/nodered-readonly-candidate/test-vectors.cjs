"use strict";
// Deliberately synthetic privacy regression vectors, generated only in memory.
// No real credential, personal identifier or location is stored in this fixture.
const marker=(...parts)=>parts.join('_');
const password=marker('PASSWORD','PRIVATE');
const jwt=[Buffer.from(JSON.stringify({alg:'none',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:'synthetic-fixture-only'})).toString('base64url'),'not-a-signature'].join('.');
const url=new URL('https://example.invalid/api');url.username='fixture-user';url.password=marker('PRIVATE','PASS');url.searchParams.set('token',marker('PRIVATE','QUERY'));
module.exports=Object.freeze({password,jwt,auth:marker('ABC','PRIVATE','TOKEN'),gh:marker('ghp','ABCDEFGHIJKLMNO'),url:url.toString(),email:'PRIVATE_NAME@example.invalid',coordinate:-(23+123456/1000000),phone:['+1','202','555-0100'].join(' '),address:'Rua Private, 123',privatePassword:marker('PRIVATE','PASSWORD')});

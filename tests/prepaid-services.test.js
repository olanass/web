'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateMetered,meteredDetails}=require('../src/server/services/metered');
const {publicOpenApi}=require('../src/server/services/openapi');
test('prepaid listings advertise account payments; legacy escrow metadata is preserved',()=>{
  const service={billingMode:'metered',currency:'USDG',price:null,endpointUrl:'https://inference.example/api/inference/prepaid/chat/completions',
    openapiDocument:{openapi:'3.0.3',info:{title:'test',version:'1'},paths:{}}};
  assert.equal(validateMetered(service,service.endpointUrl),true);
  const details=meteredDetails(service);
  assert.equal(details.scheme,'prepaid-balance');
  assert.equal(details.depositUrl,'https://inference.example/api/inference/prepaid/deposits');
  assert.equal(details.refunds,'manual-transfer');
  assert.equal(publicOpenApi(service,service.endpointUrl)['x-olanas-payment'].scheme,'prepaid-balance');
  const legacy={...service,endpointUrl:'https://inference.example/api/inference/escrow/chat/completions'};
  assert.equal(validateMetered(legacy,legacy.endpointUrl),true);
  assert.equal(meteredDetails(legacy).scheme,'batch-settlement');
  assert.equal(publicOpenApi(legacy,legacy.endpointUrl)['x-olanas-payment'].scheme,'batch-settlement');
  assert.throws(()=>validateMetered({...service,price:'1'},service.endpointUrl));
  assert.throws(()=>validateMetered(service,service.endpointUrl+'?receiver=attacker'));
  assert.throws(()=>validateMetered(service,'https://inference.example/api/unknown'));
});

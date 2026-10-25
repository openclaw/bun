// Pure fixture construction shared by runners and direct current-schema checks.
function baseConfig({workspace,port,token}) {
  return {gateway:{mode:'local',bind:'loopback',port,auth:{mode:'token',token},controlUi:{enabled:false}},
    agents:{defaults:{workspace},entries:{main:{}}},browser:{enabled:false},update:{checkOnStart:false}};
}
export function coreFixtureConfig({workspace,port,token,mockPort,applyMockOpenAiModelConfig,knowledgeControl=false}) {
  const cfg=baseConfig({workspace,port,token});
  cfg.tools={allow:[],deny:['*']};
  applyMockOpenAiModelConfig(cfg,{mockPort,modelRef:'openai/p6-deterministic'});
  if(knowledgeControl) {
    cfg.plugins={enabled:true,allow:['knowledge','openai'],slots:{memory:'knowledge'},entries:{
      openai:{enabled:true},knowledge:{enabled:true,config:{maintenance:{enabled:false}}}}};
    cfg.tools={allow:['knowledge_status','knowledge_ontology','tool_search','tool_describe','dispatch_action']};
    cfg.skills={allowBundled:[]};
  }
  return cfg;
}
export function capabilityFixtureConfig({workspace,port,token,scenario,mockPort,applyMockOpenAiModelConfig}) {
  const cfg=baseConfig({workspace,port,token});
  Object.assign(cfg.agents.defaults,{skipBootstrap:true,utilityModel:'',sandbox:{mode:'off'}});
  cfg.plugins={enabled:true};
  if(scenario!=='plugin') {
    applyMockOpenAiModelConfig(cfg,{mockPort,modelRef:'openai/p6-capability'});
    cfg.models.mode='replace';cfg.models.catalogRefresh={enabled:false};
    cfg.tools={profile:'full',loopDetection:{enabled:true},codeMode:{enabled:scenario==='node-vm',executor:'node'},exec:{host:'gateway',mode:'full'}};
  }
  return cfg;
}

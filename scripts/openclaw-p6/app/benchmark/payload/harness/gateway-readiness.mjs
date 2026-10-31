// Same log pattern and gateway-ready HTTP contract as openclaw-e2e-instance.sh.
export function hasGatewayReadyLog(text) {
  return /\[gateway\] (ready|http server listening)/.test(text);
}
export async function isGatewayReadyResponse(response) {
  if(response.status!==200)return false;
  try{return (await response.json())?.ready===true;}catch{return false;}
}

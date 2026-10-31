struct Settings {
  mm2frac: mat4x4f,
  gradToMM: mat4x4f,
  profile: vec4f, // radius mm, threshold low, threshold high, strength
  mode: vec4f, // 0: absolute second derivative; 1: high endpoint; 2: positive second derivative
}
@group(0) @binding(0) var huTex: texture_3d<f32>;
@group(0) @binding(1) var gradTex: texture_3d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> S: Settings;
@group(0) @binding(4) var outTex: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let dims=textureDimensions(huTex);
  if(any(gid>=dims)){return;}
  let p=vec3i(gid);
  let grad=textureLoad(gradTex,p,0).xyz;
  let g=(S.gradToMM*vec4f(grad,0.0)).xyz;
  let n=g/max(length(g),1e-6);
  let pf=(vec3f(gid)+0.5)/vec3f(dims);
  let delta=(S.mm2frac*vec4f(n*S.profile.x,0.0)).xyz;
  let h=textureLoad(huTex,p,0).r;
  let lo=textureSampleLevel(huTex,samp,pf-delta,0.0).r;
  let hi=textureSampleLevel(huTex,samp,pf+delta,0.0).r;
  let d2=(hi-2.0*h+lo)/(S.profile.x*S.profile.x);
  var feature=abs(d2);
  if(S.mode.x==1.0){feature=max(hi,lo);}
  if(S.mode.x==2.0){feature=max(d2,0.0);}
  // This experimental profile only attenuates the angio vessel-intensity band.
  let band=smoothstep(100.0,160.0,h)*(1.0-smoothstep(350.0,450.0,h));
  let weight=1.0-S.profile.w*band*smoothstep(S.profile.y,S.profile.z,feature);
  textureStore(outTex,p,vec4f(grad,weight));
}

import json,time,sys
from pathlib import Path
import nibabel as nib
import numpy as np
from scipy.ndimage import sobel,map_coordinates,binary_dilation,binary_erosion
dataset=sys.argv[1] if len(sys.argv)>1 else 's1212'
root=Path('/Users/chris/src/cinematic/Totalsegmentator')/dataset
n=nib.load(root/'ct.nii.gz');v=n.get_fdata(dtype=np.float32);spacing=np.array(n.header.get_zooms())
bone=np.zeros(v.shape,dtype=bool);vessels=bone.copy()
for p in (root/'segmentations').glob('*.nii.gz'):
 name=p.name
 if name.startswith(('vertebrae_','rib_','hip_','femur_','sacrum','sternum')):bone|=np.asarray(nib.load(p).dataobj)>0
 elif name.startswith(('aorta.','iliac_artery_','common_carotid_artery_','portal_vein')):vessels|=np.asarray(nib.load(p).dataobj)>0
boundary=binary_dilation(bone)&~binary_erosion(bone)
interior=binary_erosion(vessels)
grad=np.stack([sobel(v,axis=a,mode='nearest')/(32*spacing[a]) for a in range(3)])
mag=np.sqrt(np.sum(grad**2,axis=0));out={}
def smooth(a,b,x):
 t=np.clip((x-a)/(b-a),0,1);return t*t*(3-2*t)
for name,mask in [('bone_boundary',boundary),('vessel_interior',interior),('vessel_surface',vessels&~interior)]:
 mask=mask&(v>=100)&(v<=450)&(mag<160)
 coords=np.array(np.where(mask));h=v[mask];g=grad[:,mask];g/=np.maximum(np.linalg.norm(g,axis=0),1e-6)
 band=smooth(100,160,h)*(1-smooth(350,450,h))
 out[name]={'count':len(h),'profiles':{}}
 for mode,radius,low,high in [(0,1,50,150),(0,2,25,75),(2,2,25,75),(1,4,450,650),(2,1,10,50),(2,2,5,25)]:
  delta=g*radius/spacing[:,None]
  hi=map_coordinates(v,coords+delta,order=1,mode='nearest');lo=map_coordinates(v,coords-delta,order=1,mode='nearest')
  d2=(hi-2*h+lo)/(radius*radius)
  feature=np.abs(d2) if mode==0 else np.maximum(hi,lo) if mode==1 else np.maximum(d2,0)
  attenuation=band*smooth(low,high,feature)
  out[name]['profiles'][f'{mode}-{radius}-{low}-{high}']={'meanAttenuation':float(np.mean(attenuation)),'fractionOverHalf':float(np.mean(attenuation>.5))}
print(json.dumps(out,indent=2));Path(f'scratch/boundary-study/materials-{dataset}.json').write_text(json.dumps(out,indent=2))

// compute.wgsl
@group(0) @binding(0) var inputTex: texture_3d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_3d<rgba8unorm, write>;

fn sample_voxel(px: i32, py: i32, pz: i32, s: vec3<i32>, tex: texture_3d<f32>) -> f32 {
    let coords = clamp(vec3<i32>(px, py, pz), vec3<i32>(0), s - vec3<i32>(1));
    return textureLoad(tex, coords, 0).r;
}

// Changed from 8, 8, 8 (512) to 8, 8, 4 (256) to meet default limits
@compute @workgroup_size(8, 8, 4) 
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let size = vec3<i32>(textureDimensions(inputTex));
    let x = i32(id.x);
    let y = i32(id.y);
    let z = i32(id.z);

    if (x >= size.x || y >= size.y || z >= size.z) { return; }

    // Use the now global helper function
    let TAR = sample_voxel(x+1, y+1, z+1, size, inputTex);
    let TAL = sample_voxel(x-1, y+1, z+1, size, inputTex);
    let TPR = sample_voxel(x+1, y-1, z+1, size, inputTex);
    let TPL = sample_voxel(x-1, y-1, z+1, size, inputTex);
    let BAR = sample_voxel(x+1, y+1, z-1, size, inputTex);
    let BAL = sample_voxel(x-1, y+1, z-1, size, inputTex);
    let BPR = sample_voxel(x+1, y-1, z-1, size, inputTex);
    let BPL = sample_voxel(x-1, y-1, z-1, size, inputTex);

    var grad: vec3<f32>;
    grad.x = (TAL + TPL + BAL + BPL) - (TAR + TPR + BAR + BPR);
    grad.y = (TPR + TPL + BPR + BPL) - (TAR + TAL + BAR + BAL);
    grad.z = (BAR + BAL + BPR + BPL) - (TAR + TAL + TPR + TPL);

    let magnitude = (abs(grad.x) + abs(grad.y) + abs(grad.z)) * 0.29;
    let dirColor = normalize(grad + 0.00001) * 0.5 + 0.5; // Avoid div by zero

    textureStore(outputTex, id, vec4<f32>(dirColor, magnitude));
}
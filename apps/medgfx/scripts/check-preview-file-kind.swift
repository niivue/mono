//
//  check-preview-file-kind.swift
//  Self-check for the routing rules.
//
//  Lives OUTSIDE `QuickLookPreview/` on purpose: that directory is an Xcode
//  file-system-synchronized group, so anything dropped in it is compiled into
//  the extension. A test binary is not something to ship in an appex.
//
//  Run it directly, no Xcode and no test host:
//
//    bash scripts/check-preview-file-kind.sh
//
//  The cases that matter are the declines. This extension claims every gzip on
//  the machine, so "a foreign archive is handed back" is the obligation that
//  comes with that claim — if this file stops failing when that breaks, it is
//  worthless.
//

import Foundation

var failures = 0

func expect(_ name: String, _ path: String, _ want: String?) {
    let got = PreviewFileKind(url: URL(fileURLWithPath: path))?.family
    let ok = got == want
    if !ok { failures += 1 }
    print("\(ok ? "PASS" : "FAIL")  \(name) — \(path) -> \(got ?? "decline")")
}

@main
enum Check {
    static func main() {
        run()
        print(failures == 0 ? "\nall checks passed" : "\n\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}

func run() {

// Volumes, plain and compressed.
expect("nifti", "/t/brain.nii", "volume")
expect("gzipped nifti", "/t/brain.nii.gz", "volume")
expect("freesurfer mgz", "/t/orig.mgz", "volume")
expect("freesurfer mgh", "/t/orig.mgh", "volume")
expect("gzipped mgh", "/t/orig.mgh.gz", "volume")
expect("nrrd", "/t/vol.nrrd", "volume")
expect("gzipped nrrd", "/t/vol.nrrd.gz", "volume")
expect("metaimage", "/t/vol.mha", "volume")
// Not in the v1 format boundary and no UTI declared - must decline.
expect("mrtrix mif", "/t/dwi.mif", nil)
expect("gzipped mrtrix", "/t/dwi.mif.gz", nil)

// Geometry — a different NiiVue loader, so the family must differ.
expect("gifti", "/t/lh.gii", "mesh")
expect("mz3", "/t/cortex.mz3", "mesh")
expect("tck", "/t/tract.tck", "mesh")
expect("trk", "/t/tract.trk", "mesh")
expect("trx", "/t/colby.trx", "mesh")

// The obligation. We are the previewer for every gzip on this machine.
expect("foreign tarball", "/t/source.tar.gz", nil)
expect("bare gzip", "/t/notes.txt.gz", nil)
expect("naked gz", "/t/blob.gz", nil)
expect("zip", "/t/archive.zip", nil)
expect("no extension", "/t/README", nil)
expect("unrelated", "/t/photo.jpeg", nil)

// Case and path shape must not change the answer.
expect("uppercase", "/t/BRAIN.NII.GZ", "volume")
expect("mixed case mesh", "/t/Cortex.Mz3", "mesh")
expect("dots in stem", "/t/sub-01_ses-2.T1w.nii.gz", "volume")
expect("dir with dots", "/t/study.v2/brain.nii", "volume")

// `.gii.gz` routes as a mesh. The gap the source repo documented was a
// limitation of its content sniff, not of NiiVue -- see PreviewFileKind.
expect("gzipped gifti", "/t/lh.gii.gz", "mesh")

}


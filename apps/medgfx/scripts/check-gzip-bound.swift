//
//  check-gzip-bound.swift
//  Regression check for the decompression bound.
//
//  Lives outside `QuickLookPreview/` because that directory is an Xcode
//  file-system-synchronized group and would compile this into the appex.
//
//  Run it: bash scripts/check-gzip-bound.sh
//
//  The case that matters is a bomb whose NAME lies. `GzipPeek` was once called
//  only when `PreviewFileKind.isGzipped(url)` said so — a filename test — while
//  every decoder downstream (`nifti.isCompressed`, `NVGz.maybeDecompress`, the
//  mesh readers) switches on the `1f 8b` magic bytes. So `cp bomb.gz bomb.nii`
//  skipped the bound entirely and NiiVue inflated it in the content process.
//  The bound is now unconditional. If anyone reintroduces a name-based gate in
//  front of it, the `.nii` and `.mz3` cases below fail.
//

import Foundation

@main
enum BombCheck {
    static func main() {
        let limit = 256 * 1024 * 1024
        var failures = 0

        func expect(_ path: String, exceeds want: Bool) {
            let got = GzipPeek.inflatedSize(ofFileAt: URL(fileURLWithPath: path), exceeds: limit)
            if got != want { failures += 1 }
            print("\(got == want ? "PASS" : "FAIL")  \(path) -> exceeds=\(got)")
        }

        // Same bytes, three names. All must be refused.
        expect("/tmp/medgfx-bomb/bomb.gz", exceeds: true)
        expect("/tmp/medgfx-bomb/bomb.nii", exceeds: true)
        expect("/tmp/medgfx-bomb/bomb.mz3", exceeds: true)
        // And a real volume must still be accepted.
        expect("medgfx/mni152.nii.gz", exceeds: false)

        print(failures == 0 ? "\nall checks passed" : "\n\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}

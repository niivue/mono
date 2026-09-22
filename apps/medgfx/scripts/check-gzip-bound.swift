//
//  check-gzip-bound.swift
//  Regression check for the decompression bound — at the REAL call site.
//
//  Run it: bash scripts/check-gzip-bound.sh
//
//  This calls `PreviewViewController.budgetFailure`, not `GzipPeek` directly.
//  The earlier version compiled only `GzipPeek.swift`, so a name-based gate
//  reintroduced in front of the bound was invisible to it — the one regression
//  it advertised was the one it could not catch. An audit demonstrated exactly
//  that: the gate was put back and every check still passed.
//
//  The case that matters is a bomb whose NAME lies. Every decoder downstream
//  switches on the `1f 8b` magic bytes, so the defence cannot be selected by a
//  filename the attacker chooses.
//

import Foundation

@main
enum BombCheck {
    static var failures = 0

    static func expect(_ path: String, _ want: PreviewFailure?) {
        let url = URL(fileURLWithPath: path)
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        let got = PreviewViewController.budgetFailure(fileSize: size, url: url)
        let ok = got == want
        if !ok { failures += 1 }
        print("\(ok ? "PASS" : "FAIL")  \((path as NSString).lastPathComponent) -> \(got?.rawValue ?? "accept")")
    }

    static func main() {
        let dir = "/tmp/medgfx-bomb/"
        // Same bytes, three names, all refused. `.nii` and `.mz3` are the ones
        // that fail if anyone gates the bound on the filename again.
        expect(dir + "bomb.gz", .resourceLimit)
        expect(dir + "bomb.nii", .resourceLimit)
        expect(dir + "bomb.mz3", .resourceLimit)
        // A 4D header claiming a huge decoded size, gzip content, bare `.nii`.
        expect(dir + "bomb4d.nii", .resourceLimit)
        // A real volume must still be accepted.
        expect("medgfx/mni152.nii.gz", nil)
        // Gzip whose FEXTRA overruns the header window: must fail CLOSED.
        expect(dir + "fextra.nii", .resourceLimit)
        // Unreadable size fails closed.
        expect(dir + "does-not-exist.nii", .unreadable)

        print(failures == 0 ? "\nall checks passed" : "\n\(failures) FAILED")
        exit(failures == 0 ? 0 : 1)
    }
}

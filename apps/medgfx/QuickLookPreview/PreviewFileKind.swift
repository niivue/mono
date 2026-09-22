//
//  PreviewFileKind.swift
//  Which files this extension will draw, decided by filename.
//
//  Adopted from MIQ's `MIQFileKind` and NIfTIViewQL, the two shipping macOS
//  Quick Look extensions for this family of formats. Both take the same shape,
//  and it is the shape that works in the field:
//
//    1. Claim broadly in `QLSupportedContentTypes` — including `public.gzip`
//       and `org.gnu.gnu-zip-archive`. This is the ONLY route by which a
//       `.nii.gz` reaches an extension at all: macOS resolves a file's type
//       from the LAST extension component, so a `.nii.gz` is always, simply, a
//       gzip. A compound `nii.gz` UTI is deliberately NOT declared: it
//       registers happily and can never match, for exactly that reason.
//
//    2. Decline by name here. A foreign `.tar.gz` costs one string comparison
//       and no file I/O at all, and Finder falls back to whatever would
//       otherwise have previewed it.
//
//  The trade this makes, stated plainly: a NIfTI renamed to `.gz` is not
//  previewed, and a non-NIfTI named `.nii.gz` is attempted and fails visibly.
//  Content sniffing would catch both. Two shipping tools say the field does not
//  care, and sniffing cost ~340 lines that had to be hostile-input hardened
//  because it ran against every gzip on the machine.
//
//  Note this decides only WHETHER to draw. The size budget is separate and
//  MUST stay content-derived — see `GzipPeek.inflatedSize`, which is now called
//  unconditionally. There used to be an `isGzipped(_:)` helper here that gated
//  the bound on the filename; it was a hole, because every decoder downstream
//  switches on the `1f 8b` magic bytes instead, so `cp bomb.gz bomb.nii` skipped
//  the bound and inflated anyway. Do not reintroduce a name-based gate in front
//  of a content-based defence.
//

import Foundation

enum PreviewFileKind {
    case volume
    case mesh

    /// Compound suffixes, matched before the plain extension so `.mgh.gz` is
    /// not mistaken for a bare `.gz`. Order matters within the array only in
    /// that the first match wins; no two entries overlap.
    private static let compound: [(suffix: String, kind: PreviewFileKind)] = [
        (".nii.gz", .volume),
        (".mgh.gz", .volume),
        (".nrrd.gz", .volume),
        (".mha.gz", .volume),
        // Was a documented gap in the source repo, for a reason that no longer
        // applies: its content sniff could not recognise GIFTI XML, so a
        // `.gii.gz` looked like a foreign archive. Routing by name has no such
        // problem, and NiiVue handles the rest already -- `getFileExt` strips
        // `.gz` (`img.trk.gz` -> TRK), and the GIFTI reader inflates on the
        // 0x1f magic byte itself.
        (".gii.gz", .mesh),
    ]

    /// Single-component extensions. `.gz` is deliberately absent: a bare `.gz`
    /// with no format extension under it is exactly the foreign archive this
    /// extension is obliged to hand back.
    ///
    /// MRtrix `.mif`/`.mif.gz` is deliberately absent too, though MIQ claims it
    /// and NiiVue can read it: it is not in the v1 format boundary, and no
    /// `org.mrtrix.mif` UTI is declared, so a bare `.mif` could never route here
    /// anyway. Add the UTI and the entries together if it is ever wanted.
    private static let simple: [String: PreviewFileKind] = [
        "nii": .volume,
        "mgh": .volume,
        "mgz": .volume,
        "nrrd": .volume,
        "mha": .volume,
        "gii": .mesh,
        "mz3": .mesh,
        "tck": .mesh,
        "trk": .mesh,
        "trx": .mesh,
    ]

    /// Nil when the file is not ours, which is the caller's cue to decline.
    init?(url: URL) {
        let name = url.lastPathComponent.lowercased()
        if let match = Self.compound.first(where: { name.hasSuffix($0.suffix) }) {
            self = match.kind
            return
        }
        // ponytail: `pathExtension` on a name with no dot returns "", which
        // misses nothing — an extensionless file is not a format we claim.
        guard let kind = Self.simple[(name as NSString).pathExtension] else { return nil }
        self = kind
    }

    /// Which NiiVue loader the page should use. The page cannot work this out
    /// itself: the document route it fetches carries an opaque token, and the
    /// native side is what knows the real filename.
    var family: String {
        switch self {
        case .volume: return "volume"
        case .mesh: return "mesh"
        }
    }
}

//
//  GzipPeek.swift
//  Streaming size bound for gzip payloads.
//
//  Routing is by filename (see `PreviewFileKind`), so this file no longer
//  identifies formats — it answers one question: does this gzip member inflate
//  to more than we are willing to hand WebKit?
//
//  That question still has to be asked, though the reason has changed.
//
//  `limitFrames4D` NOW bounds decoding: both NiiVue load paths reach the
//  partial reader, so a 4D preview inflates `vox_offset + one frame` rather
//  than the series. (It did not before — a 2.65 MB 4D `.nii.gz` drove the
//  content process to 5.4 GiB while the strip read "1 of 2600".)
//
//  This bound stays UNCONDITIONAL anyway, and the reasons are worth stating
//  because a stale note here is what licensed an earlier attempt to skip it:
//    - the partial reader covers NIfTI only. `.mgz`, `.nrrd.gz`, `.gii.gz` and
//      every mesh format are still inflated whole.
//    - it returns nil on ANY miss — malformed header, byte-swapped, a blanket
//      catch — and the caller then full-loads, unbounded.
//    - NiiVue picks it by FILENAME, so gzip content under a name it does not
//      recognise is full-loaded regardless of what the bytes say.
//    - defence in depth: this is a security boundary for every gzip on the
//      machine, and it must not depend on a prediction about the browser.
//
//  Deliberately NOT ported: `VolumeSniff` (NIfTI header parsing). Its `isNIfTI`
//  did routing, now done by name, and its `decodedSize` is redundant for
//  budgeting — uncompressed files are bounded by the file-size cap, compressed
//  ones by the inflate bound below.
//

import Foundation
import Compression

enum GzipPeek {

    /// Compressed bytes read from disk before the streaming inflate begins.
    /// A gzip header plus the first block of a real volume is far smaller.
    private static let compressedBudget = 64 * 1024


    /// Offset of the raw DEFLATE payload within a gzip member, or nil if this
    /// is not gzip. Sole caller is `inflatedSize` below; kept separate because
    /// distinguishing "not gzip" from "unparseable gzip header" is what makes
    /// the fail-closed branch there possible.
    private static func deflateOffset(in data: Data) -> Int? {
        var index = data.startIndex
        func take(_ n: Int) -> Data? {
            guard data.distance(from: index, to: data.endIndex) >= n else { return nil }
            let end = data.index(index, offsetBy: n)
            defer { index = end }
            return data[index..<end]
        }
        // Fixed 10-byte gzip header.
        guard let header = take(10), header.count == 10 else { return nil }
        let bytes = [UInt8](header)
        guard bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 8 else { return nil }
        let flags = bytes[3]

        if flags & 0x04 != 0 { // FEXTRA
            guard let xlen = take(2) else { return nil }
            let n = Int([UInt8](xlen)[0]) | Int([UInt8](xlen)[1]) << 8
            guard take(n) != nil else { return nil }
        }
        for flag in [UInt8(0x08), UInt8(0x10)] where flags & flag != 0 { // FNAME, FCOMMENT
            while true {
                guard let byte = take(1) else { return nil }
                if byte.first == 0 { break }
            }
        }
        if flags & 0x02 != 0, take(2) == nil { return nil } // FHCRC
        return data.distance(from: data.startIndex, to: index)
    }

    /// True when the gzip member at `url` inflates to more than `limit` bytes.
    ///
    /// The whole memory policy for compressed input, now that routing is by
    /// name. Every compressed kind we accept — `.nii.gz`, `.mgh.gz`, `.mgz`,
    /// `.nrrd.gz`, `.mha.gz`, `.gii.gz` — is a gzip member, and a bomb is a bomb whatever
    /// is inside, so one format-agnostic gate covers all of them. It is the
    /// only thing standing between a crafted payload and the content process.
    ///
    /// Output is inflated into one reused buffer and discarded; only the
    /// running total is kept, so the peak cost here is `chunkBytes`, not the
    /// payload.
    ///
    /// Stops the moment the limit is passed, so a 1000:1 bomb costs `limit`
    /// bytes of work rather than the whole expansion. Compare the gzip ISIZE
    /// trailer, which is tempting and wrong: it is modulo 2³² and describes
    /// only the last member.
    ///
    /// Returns false for anything that is not gzip — uncompressed files are
    /// already bounded by the source-size cap, since decoded ≈ bytes on disk.
    ///
    /// **Counts the FIRST member only, and that is safe by coupling, not by
    /// design.** `gunzip`, node `zlib` and pako all decode concatenated members;
    /// the two decoders NiiVue actually reaches do not — WebKit's
    /// `DecompressionStream('gzip')` throws "Extra bytes past the end", and
    /// `nifti-reader-js` uses fflate, measured to return member one alone. So a
    /// bomb hidden in member two cannot be decoded by the preview either. If
    /// NiiVue ever swaps decompressor, re-check this: it becomes exploitable the
    /// day the browser side decodes more members than this does.
    static func inflatedSize(ofFileAt url: URL, exceeds limit: Int) -> Bool {
        // FAIL CLOSED on I/O trouble. A file we cannot read is one we cannot
        // bound, and the caller's alternative is handing it to WebKit unmeasured.
        // Refusing costs a legitimate file nothing it was going to get anyway —
        // the preview would fail on the same unreadable bytes moments later.
        guard let handle = try? FileHandle(forReadingFrom: url) else { return true }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: compressedBudget) else { return true }

        // FAIL CLOSED when the bytes are gzip but the header will not resolve.
        // `deflateOffset` returns nil both for "not gzip" and for "gzip whose
        // FNAME/FCOMMENT/FEXTRA runs past the 64 KiB window", and conflating
        // those made a single legal FEXTRA with `xlen = 65535` disable the whole
        // check: a 1.1 MB file inflating to 1 GiB was waved through in 0.000 s.
        let looksGzip = head.count >= 3 && [UInt8](head.prefix(3)) == [0x1f, 0x8b, 0x08]
        guard let offset = deflateOffset(in: head), offset < head.count else { return looksGzip }

        var stream = compression_stream(dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!,
                                        dst_size: 0,
                                        src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!,
                                        src_size: 0, state: nil)
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE,
                                      COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            return looksGzip
        }
        defer { compression_stream_destroy(&stream) }

        var produced = 0
        var output = [UInt8](repeating: 0, count: chunkBytes)
        var input: Data? = head.subdata(in: (head.startIndex + offset)..<head.endIndex)
        var status = COMPRESSION_STATUS_OK

        while let chunk = input {
            var stalled = false
            let overflowed: Bool = chunk.withUnsafeBytes { src -> Bool in
                guard let srcBase = src.bindMemory(to: UInt8.self).baseAddress else { return false }
                stream.src_ptr = srcBase
                stream.src_size = chunk.count
                repeat {
                    let remaining = stream.src_size
                    let wrote: Int = output.withUnsafeMutableBufferPointer { dst -> Int in
                        stream.dst_ptr = dst.baseAddress!
                        stream.dst_size = dst.count
                        status = compression_stream_process(&stream, 0)
                        return dst.count - stream.dst_size
                    }
                    produced += wrote
                    if produced > limit { return true }
                    if status != COMPRESSION_STATUS_OK { return false }
                    // A genuine stall is no output AND no input consumed. Testing
                    // output alone was the bug: an empty stored block — the five
                    // bytes zlib emits for Z_SYNC_FLUSH — consumes input and
                    // emits nothing, so 64 KiB of them made this return "fine"
                    // at the very first call, before a byte of payload was seen.
                    if wrote == 0 && stream.src_size == remaining { stalled = true; return false }
                } while stream.src_size > 0
                return false
            }
            if overflowed { return true }
            // RESIDUAL FAIL-OPEN, deliberately left. A mid-stream stall or
            // decoder error allows the file. Failing closed here would refuse
            // legitimate volumes whenever Apple's decoder disagrees with the
            // browser's zlib/fflate about a stream those two implementations
            // read differently, which is the more likely event. No input that
            // reaches this branch has been constructed; if one ever is, this is
            // the line to change.
            if status != COMPRESSION_STATUS_OK || stalled { return false }
            input = (try? handle.read(upToCount: chunkBytes)).flatMap { $0.isEmpty ? nil : $0 }
        }

        // Drain. At EOF Apple's decoder still holds up to one internal buffer of
        // undelivered output — measured at 64 MiB, a 25% undercount against a
        // 256 MB limit — so a file just over the line reads as just under.
        stream.src_ptr = UnsafePointer<UInt8>(bitPattern: 1)!
        stream.src_size = 0
        while true {
            let wrote: Int = output.withUnsafeMutableBufferPointer { dst -> Int in
                stream.dst_ptr = dst.baseAddress!
                stream.dst_size = dst.count
                stream.src_size = 0
                status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                return dst.count - stream.dst_size
            }
            produced += wrote
            if produced > limit { return true }
            if status != COMPRESSION_STATUS_OK || wrote == 0 { return false }
        }
    }

    /// Working buffer for the streaming inflate, in and out.
    private static let chunkBytes = 256 * 1024
}

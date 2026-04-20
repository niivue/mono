import { log } from "@/logger";

interface Entry {
  signature: string;
  version: number;
  generalPurpose: number;
  compressionMethod: number;
  lastModifiedTime: number;
  lastModifiedDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  fileNameLength: number;
  extraLength: number;
  fileName: string;
  extra: string;
  startsAt?: number;
  extract?: () => Promise<Uint8Array>;
}

interface CentralDirectoryEntry {
  versionCreated: number;
  versionNeeded: number;
  fileCommentLength: number;
  diskNumber: number;
  internalAttributes: number;
  externalAttributes: number;
  offset: number;
  comments: string;
  fileNameLength: number;
  extraLength: number;
}

interface EndOfCentralDirectory {
  numberOfDisks: number;
  centralDirectoryStartDisk: number;
  numberCentralDirectoryRecordsOnThisDisk: number;
  numberCentralDirectoryRecords: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  commentLength: number;
  comment: string;
}

export class Zip {
  #dataView: DataView;
  #index: number = 0;
  #localFiles: Entry[] = [];
  #centralDirectories: CentralDirectoryEntry[] = [];
  #endOfCentralDirectory?: EndOfCentralDirectory;

  constructor(arrayBuffer: ArrayBuffer) {
    this.#dataView = new DataView(arrayBuffer);
    this.read();
  }

  async extract(entry: Entry): Promise<Uint8Array> {
    const buffer = new Uint8Array(
      this.#dataView.buffer.slice(
        entry.startsAt!,
        entry.startsAt! + entry.compressedSize,
      ),
    );
    if (entry.compressionMethod === 0x00) {
      return buffer;
    } else if (entry.compressionMethod === 0x08) {
      const stream = new DecompressionStream("deflate-raw");
      const writer = stream.writable.getWriter();
      writer
        .write(new Uint8Array(buffer))
        .catch((e) => log.error("NVZip write error", e));
      const closePromise = writer
        .close()
        .catch((e) => log.error("NVZip close error", e));
      const response = new Response(stream.readable);
      const result = new Uint8Array(await response.arrayBuffer());
      await closePromise;
      return result;
    }
    throw new Error(
      `Unsupported compression method: ${entry.compressionMethod}`,
    );
  }

  private read(): void {
    while (
      !this.#endOfCentralDirectory &&
      this.#index < this.#dataView.byteLength
    ) {
      const signature = this.#dataView.getUint32(this.#index, true);
      if (signature === 0x04034b50) {
        const entry = this.readLocalFile(this.#index);
        entry.extract = this.extract.bind(this, entry);
        this.#localFiles.push(entry);
        const hasDataDescriptor = (entry.generalPurpose & 0x0008) !== 0;
        entry.startsAt =
          this.#index + 30 + entry.fileNameLength + entry.extraLength;
        if (entry.compressedSize === 0 && hasDataDescriptor) {
          let scanIndex = entry.startsAt;
          while (scanIndex! + 20 <= this.#dataView.byteLength) {
            const possibleSignature = this.#dataView.getUint32(
              scanIndex!,
              true,
            );
            if (possibleSignature === 0x08074b50) {
              const nextPK =
                this.#dataView.getUint16(scanIndex! + 16, true) === 0x4b50;
              if (nextPK) {
                scanIndex! += 4;
                break;
              }
            }
            scanIndex!++;
          }
          entry.crc = this.#dataView.getUint32(scanIndex!, true);
          entry.compressedSize = this.#dataView.getUint32(scanIndex! + 4, true);
          entry.uncompressedSize = this.#dataView.getUint32(
            scanIndex! + 8,
            true,
          );
          this.#index = scanIndex! + 12;
        } else {
          this.#index = entry.startsAt + entry.compressedSize;
        }
      } else if (signature === 0x02014b50) {
        const entry = this.readCentralDirectory(this.#index);
        this.#centralDirectories.push(entry);
        this.#index +=
          46 +
          entry.fileNameLength +
          entry.extraLength +
          entry.fileCommentLength;
      } else if (signature === 0x06054b50) {
        this.#endOfCentralDirectory = this.readEndCentralDirectory(this.#index);
        break;
      } else if (signature === 0x06064b50) {
        this.#endOfCentralDirectory = this.readEndCentralDirectory64(
          this.#index,
        );
        break;
      } else {
        log.error(
          `Unexpected ZIP signature 0x${signature.toString(16).padStart(8, "0")} at index ${this.#index}`,
        );
        break;
      }
    }
  }

  private readLocalFile(offset: number): Entry {
    let compressedSize = this.#dataView.getUint32(offset + 18, true);
    let uncompressedSize = this.#dataView.getUint32(offset + 22, true);
    const fileNameLength = this.#dataView.getUint16(offset + 26, true);
    const extraLength = this.#dataView.getUint16(offset + 28, true);
    const extraOffset = offset + 30 + fileNameLength;
    if (compressedSize === 0xffffffff && uncompressedSize === 0xffffffff) {
      let zip64Offset = extraOffset;
      let foundZip64 = false;
      while (zip64Offset < extraOffset + extraLength - 4) {
        const fieldSignature = this.#dataView.getUint16(zip64Offset, true);
        const fieldLength = this.#dataView.getUint16(zip64Offset + 2, true);
        zip64Offset += 4;
        if (fieldSignature === 0x0001) {
          if (fieldLength >= 16) {
            uncompressedSize = Number(
              this.#dataView.getBigUint64(zip64Offset, true),
            );
            zip64Offset += 8;
            compressedSize = Number(
              this.#dataView.getBigUint64(zip64Offset, true),
            );
            foundZip64 = true;
            break;
          } else {
            throw new Error(
              `ZIP64 extra field found but is too small (expected at least 16 bytes, got ${fieldLength}).`,
            );
          }
        }
        zip64Offset += fieldLength;
      }
      if (!foundZip64) {
        throw new Error(
          "ZIP64 format missing extra field with signature 0x0001.",
        );
      }
    }
    return {
      signature: this.readString(offset, 4),
      version: this.#dataView.getUint16(offset + 4, true),
      generalPurpose: this.#dataView.getUint16(offset + 6, true),
      compressionMethod: this.#dataView.getUint16(offset + 8, true),
      lastModifiedTime: this.#dataView.getUint16(offset + 10, true),
      lastModifiedDate: this.#dataView.getUint16(offset + 12, true),
      crc: this.#dataView.getUint32(offset + 14, true),
      compressedSize,
      uncompressedSize,
      fileNameLength,
      extraLength,
      fileName: this.readString(offset + 30, fileNameLength),
      extra: this.readString(offset + 30 + fileNameLength, extraLength),
    };
  }

  private readCentralDirectory(offset: number): CentralDirectoryEntry {
    return {
      versionCreated: this.#dataView.getUint16(offset + 4, true),
      versionNeeded: this.#dataView.getUint16(offset + 6, true),
      fileNameLength: this.#dataView.getUint16(offset + 28, true),
      extraLength: this.#dataView.getUint16(offset + 30, true),
      fileCommentLength: this.#dataView.getUint16(offset + 32, true),
      diskNumber: this.#dataView.getUint16(offset + 34, true),
      internalAttributes: this.#dataView.getUint16(offset + 36, true),
      externalAttributes: this.#dataView.getUint32(offset + 38, true),
      offset: this.#dataView.getUint32(offset + 42, true),
      comments: this.readString(
        offset + 46,
        this.#dataView.getUint16(offset + 32, true),
      ),
    };
  }

  private readEndCentralDirectory(offset: number): EndOfCentralDirectory {
    const commentLength = this.#dataView.getUint16(offset + 20, true);
    return {
      numberOfDisks: this.#dataView.getUint16(offset + 4, true),
      centralDirectoryStartDisk: this.#dataView.getUint16(offset + 6, true),
      numberCentralDirectoryRecordsOnThisDisk: this.#dataView.getUint16(
        offset + 8,
        true,
      ),
      numberCentralDirectoryRecords: this.#dataView.getUint16(
        offset + 10,
        true,
      ),
      centralDirectorySize: this.#dataView.getUint32(offset + 12, true),
      centralDirectoryOffset: this.#dataView.getUint32(offset + 16, true),
      commentLength,
      comment: this.readString(offset + 22, commentLength),
    };
  }

  private readEndCentralDirectory64(offset: number): EndOfCentralDirectory {
    const commentLength = Number(this.#dataView.getBigUint64(offset + 0, true));
    return {
      numberOfDisks: this.#dataView.getUint32(offset + 16, true),
      centralDirectoryStartDisk: this.#dataView.getUint32(offset + 20, true),
      numberCentralDirectoryRecordsOnThisDisk: Number(
        this.#dataView.getBigUint64(offset + 24, true),
      ),
      numberCentralDirectoryRecords: Number(
        this.#dataView.getBigUint64(offset + 32, true),
      ),
      centralDirectorySize: Number(
        this.#dataView.getBigUint64(offset + 40, true),
      ),
      centralDirectoryOffset: Number(
        this.#dataView.getBigUint64(offset + 48, true),
      ),
      commentLength,
      comment: "",
    };
  }

  private readString(offset: number, length: number): string {
    return Array.from({ length }, (_, i) =>
      String.fromCharCode(this.#dataView.getUint8(offset + i)),
    ).join("");
  }

  get entries(): Entry[] {
    return this.#localFiles;
  }
}

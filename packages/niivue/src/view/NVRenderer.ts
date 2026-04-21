export abstract class NVRenderer {
  private _isReady = false

  get isReady(): boolean {
    return this._isReady
  }

  protected set isReady(value: boolean) {
    this._isReady = value
  }

  abstract init(...args: unknown[]): void | Promise<void>
  abstract draw(...args: unknown[]): void
  abstract destroy(): void

  resize(..._args: unknown[]): void {}
}

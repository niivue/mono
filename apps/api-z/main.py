from pathlib import Path


def get_version() -> str:
    """Read version from pixi.toml."""
    toml = Path(__file__).parent / "pixi.toml"
    for line in toml.read_text().splitlines():
        if line.startswith("version"):
            return line.split("=")[1].strip().strip('"')
    return "unknown"


def main() -> None:
    print(f"api-z v{get_version()}")
    print("Endpoints:")
    print("  GET  /health")
    print("  GET  /greet/{name}")


if __name__ == "__main__":
    main()

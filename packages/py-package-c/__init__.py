"""py-package-c library."""


def greet(name: str) -> str:
    """Return a greeting string."""
    if not name or not name.strip():
        return "Hello, world!"
    return f"Hello, {name.strip()}!"


def add(a: float, b: float) -> float:
    """Return the sum of two numbers."""
    return a + b


def subtract(a: float, b: float) -> float:
    """Return the difference of two numbers.

    Args:
        a: The minuend.
        b: The subtrahend.

    Returns:
        The difference a - b.
    """
    return a - b


def multiply(a: float, b: float) -> float:
    """Return the product of two numbers."""
    return a * b


def divide(a: float, b: float) -> float:
    """Return the quotient of two numbers."""
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b


def clamp(value: float, low: float, high: float) -> float:
    """Clamp a value between low and high bounds."""
    return max(low, min(value, high))

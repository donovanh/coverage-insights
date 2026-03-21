package com.example.app

object MathUtils {
    fun clamp(v: Int, min: Int, max: Int): Int = v.coerceIn(min, max)
    fun factorial(n: Int): Long = if (n <= 1) 1L else n * factorial(n - 1)
    fun isPrime(n: Int): Boolean = n > 1 && (2..Math.sqrt(n.toDouble()).toInt()).none { n % it == 0 }
    fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
}

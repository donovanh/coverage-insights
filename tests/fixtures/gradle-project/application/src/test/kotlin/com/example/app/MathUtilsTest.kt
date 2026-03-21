package com.example.app

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

class MathUtilsTest {
    @Test fun `clamp returns value when in range`() = assertEquals(5, MathUtils.clamp(5, 1, 10))
    @Test fun `clamp returns min when below range`() = assertEquals(1, MathUtils.clamp(-5, 1, 10))
    @Test fun `clamp returns max when above range`() = assertEquals(10, MathUtils.clamp(99, 1, 10))
    @Test fun `factorial of zero is one`() = assertEquals(1L, MathUtils.factorial(0))
    @Test fun `factorial of five is 120`() = assertEquals(120L, MathUtils.factorial(5))
    @Test fun `isPrime returns true for prime`() = assertTrue(MathUtils.isPrime(17))
    @Test fun `isPrime returns false for composite`() = assertFalse(MathUtils.isPrime(9))
    @Test fun `gcd of 12 and 8 is 4`() = assertEquals(4, MathUtils.gcd(12, 8))
}

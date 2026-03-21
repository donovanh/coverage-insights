package com.example.app

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

class StringUtilsTest {
    @Test fun `truncate short string unchanged`() = assertEquals("hi", StringUtils.truncate("hi", 10))
    @Test fun `truncate long string adds ellipsis`() = assertEquals("hel...", StringUtils.truncate("hello world", 3))
    @Test fun `isPalindrome returns true for palindrome`() = assertTrue(StringUtils.isPalindrome("racecar"))
    @Test fun `isPalindrome returns false for non palindrome`() = assertFalse(StringUtils.isPalindrome("hello"))
    @Test fun `countWords counts correctly`() = assertEquals(3, StringUtils.countWords("one two three"))
    @Test fun `countWords returns zero for blank`() = assertEquals(0, StringUtils.countWords("   "))
    @Test fun `capitalize lowercases and uppercases first`() = assertEquals("Hello", StringUtils.capitalize("HELLO"))
    @Test fun `repeat returns repeated string`() = assertEquals("abab", StringUtils.repeat("ab", 2))
}

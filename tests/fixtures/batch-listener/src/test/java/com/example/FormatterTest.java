package com.example;

import org.junit.Test;
import static org.junit.Assert.*;

public class FormatterTest {
    @Test
    public void testFormat() {
        assertEquals("42", new Formatter().format(42));
    }
}

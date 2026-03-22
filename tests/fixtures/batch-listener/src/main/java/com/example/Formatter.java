package com.example;

public class Formatter {
    public String format(int n) { return String.valueOf(n); }
    public String formatNegative(int n) { return n < 0 ? "(" + Math.abs(n) + ")" : String.valueOf(n); }
}

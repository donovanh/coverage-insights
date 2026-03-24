package helpers;

public class StringHelper {
    public static String trim(String s) {
        return s == null ? "" : s.trim();
    }
    public static String toUpperCase(String s) {
        return s == null ? "" : s.toUpperCase();
    }
}

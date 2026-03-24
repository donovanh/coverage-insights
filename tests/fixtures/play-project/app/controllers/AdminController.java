package controllers;

import play.mvc.Controller;

public class AdminController extends Controller {
    public static void list() {
        render();
    }
    public static void create() {
        redirect("/admin");
    }
    public static void view(String id) {
        render();
    }
}

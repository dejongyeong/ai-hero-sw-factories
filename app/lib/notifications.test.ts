import { describe, expect, it } from "vitest";
import { describeNotification } from "./notifications";

describe("describeNotification", () => {
  it("files a Comment reply under Discussions", () => {
    expect(
      describeNotification("comment-reply", {
        comment_id: 7,
        actor_name: "Sarah",
        lesson_title: "Generics",
        url: "/courses/intro-ts/lessons/3#comment-7",
      })?.category
    ).toBe("Discussions");
  });

  it("describes a Comment reply with its sentence and link", () => {
    expect(
      describeNotification("comment-reply", {
        comment_id: 7,
        actor_name: "Sarah",
        lesson_title: "Generics",
        url: "/courses/intro-ts/lessons/3#comment-7",
      })
    ).toEqual({
      sentence: [
        { text: "Sarah", bold: true },
        { text: " replied to your Comment on ", bold: false },
        { text: "Generics", bold: true },
      ],
      href: "/courses/intro-ts/lessons/3#comment-7",
      category: "Discussions",
    });
  });

  it("returns null for a Comment reply it can't read", () => {
    expect(
      describeNotification("comment-reply", { actor_name: "Sarah" })
    ).toBeNull();
  });

  it("returns null for an unknown workflow", () => {
    expect(describeNotification("refund-decided", {})).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  describeNotification,
  liveNewQuestion,
  newQuestionCommentIds,
} from "./notifications";

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

  it("describes Refund Request raised under Refunds, linking to the card", () => {
    expect(
      describeNotification("refund-request-raised", {
        refund_request_id: 4,
        actor_name: "Liam",
        course_title: "Introduction to TypeScript",
        amount: "$79.00",
        url: "/admin/refund-requests?request=4",
      })
    ).toEqual({
      sentence: [
        { text: "Liam", bold: true },
        { text: " requested a refund for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " ($79.00)", bold: false },
      ],
      href: "/admin/refund-requests?request=4",
      category: "Refunds",
    });
  });

  it("describes Refund Request received under Refunds, linking to the course", () => {
    expect(
      describeNotification("refund-request-received", {
        refund_request_id: 4,
        course_title: "Introduction to TypeScript",
        url: "/courses/intro-ts",
      })
    ).toEqual({
      sentence: [
        { text: "We've got your refund request for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
      ],
      href: "/courses/intro-ts",
      category: "Refunds",
    });
  });

  it("describes Refund Request approved under Refunds, linking to the course", () => {
    expect(
      describeNotification("refund-request-approved", {
        refund_request_id: 4,
        course_title: "Introduction to TypeScript",
        amount: "$79.00",
        url: "/courses/intro-ts",
      })
    ).toEqual({
      sentence: [
        { text: "Your refund for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " was approved — $79.00", bold: false },
      ],
      href: "/courses/intro-ts",
      category: "Refunds",
    });
  });

  it("describes Refund Request declined under Refunds, linking to the course", () => {
    expect(
      describeNotification("refund-request-declined", {
        refund_request_id: 4,
        course_title: "Introduction to TypeScript",
        url: "/courses/intro-ts",
      })
    ).toEqual({
      sentence: [
        { text: "Your refund request for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " was declined; you keep access", bold: false },
      ],
      href: "/courses/intro-ts",
      category: "Refunds",
    });
  });

  it("returns null for a Refund Request approved without its amount", () => {
    expect(
      describeNotification("refund-request-approved", {
        refund_request_id: 4,
        course_title: "Introduction to TypeScript",
        url: "/courses/intro-ts",
      })
    ).toBeNull();
  });

  it("describes Refund issued under Refunds, linking to the course", () => {
    expect(
      describeNotification("refund-issued", {
        refund_id: 9,
        course_title: "Introduction to TypeScript",
        amount: "$79.00",
        url: "/courses/intro-ts",
      })
    ).toEqual({
      sentence: [
        { text: "Your $79.00 refund for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " has been sent", bold: false },
      ],
      href: "/courses/intro-ts",
      category: "Refunds",
    });
  });

  it("describes the Student's Refund failed under Refunds, linking to the course", () => {
    expect(
      describeNotification("refund-failed", {
        refund_id: 9,
        course_title: "Introduction to TypeScript",
        url: "/courses/intro-ts",
      })
    ).toEqual({
      sentence: [
        { text: "We couldn't send your refund for ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: "; we're on it", bold: false },
      ],
      href: "/courses/intro-ts",
      category: "Refunds",
    });
  });

  it("describes a Platform Admin's Refund failed under Refunds, linking to the queue", () => {
    expect(
      describeNotification("refund-failed-admin", {
        refund_id: 9,
        refund_request_id: 4,
        student_name: "Liam",
        course_title: "Introduction to TypeScript",
        url: "/admin/refund-requests?request=4",
      })
    ).toEqual({
      sentence: [
        { text: "Refund for ", bold: false },
        { text: "Liam", bold: true },
        { text: " on ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " failed", bold: false },
      ],
      href: "/admin/refund-requests?request=4",
      category: "Refunds",
    });
  });

  it("returns null for a Refund issued without its amount", () => {
    expect(
      describeNotification("refund-issued", {
        refund_id: 9,
        course_title: "Introduction to TypeScript",
        url: "/courses/intro-ts",
      })
    ).toBeNull();
  });

  it("returns null for a Refund Request raised it can't read", () => {
    expect(
      describeNotification("refund-request-raised", { actor_name: "Liam" })
    ).toBeNull();
  });

  const newQuestion = {
    comment_id: 9,
    lesson_id: 3,
    actor_name: "Liam",
    lesson_title: "Generics",
    url: "/courses/intro-ts/lessons/3#comment-9",
  };

  it("describes one New question with its asker, under Discussions", () => {
    expect(describeNotification("new-question", newQuestion, 1)).toEqual({
      sentence: [
        { text: "Liam", bold: true },
        { text: " asked a question on ", bold: false },
        { text: "Generics", bold: true },
      ],
      href: "/courses/intro-ts/lessons/3#comment-9",
      category: "Discussions",
    });
  });

  it("describes a batch of New questions by their count", () => {
    expect(
      describeNotification("new-question", newQuestion, 3)?.sentence
    ).toEqual([
      { text: "3 new questions", bold: true },
      { text: " on ", bold: false },
      { text: "Generics", bold: true },
    ]);
  });

  const newPurchase = {
    purchase_id: 12,
    course_id: 4,
    actor_name: "Liam",
    course_title: "Introduction to TypeScript",
    seat_count: null,
    url: "/instructor/4/students#student-2",
  };

  it("describes an Individual Purchase by its buyer, under Enrollments", () => {
    expect(describeNotification("new-purchase", newPurchase, 1)).toEqual({
      sentence: [
        { text: "Liam", bold: true },
        { text: " bought ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
      ],
      href: "/instructor/4/students#student-2",
      category: "Enrollments",
    });
  });

  it("describes a Team Licence with its seat count", () => {
    expect(
      describeNotification("new-purchase", { ...newPurchase, seat_count: 5 }, 1)
        ?.sentence
    ).toEqual([
      { text: "Liam", bold: true },
      { text: " bought 5 seats on ", bold: false },
      { text: "Introduction to TypeScript", bold: true },
    ]);
  });

  it("describes a one-Seat Team Licence in the singular", () => {
    expect(
      describeNotification("new-purchase", { ...newPurchase, seat_count: 1 }, 1)
        ?.sentence
    ).toEqual([
      { text: "Liam", bold: true },
      { text: " bought 1 seat on ", bold: false },
      { text: "Introduction to TypeScript", bold: true },
    ]);
  });

  it("describes a batch of New purchases by their count", () => {
    expect(
      describeNotification("new-purchase", newPurchase, 3)?.sentence
    ).toEqual([
      { text: "3 new purchases", bold: true },
      { text: " of ", bold: false },
      { text: "Introduction to TypeScript", bold: true },
    ]);
  });

  it("describes a Seat claimed with its used and total Seats, under Team", () => {
    expect(
      describeNotification("seat-claimed", {
        seat_id: 9,
        actor_name: "Liam",
        course_title: "Introduction to TypeScript",
        used_seats: 2,
        total_seats: 5,
        url: "/team",
      })
    ).toEqual({
      sentence: [
        { text: "Liam", bold: true },
        { text: " claimed a seat on ", bold: false },
        { text: "Introduction to TypeScript", bold: true },
        { text: " (2/5)", bold: false },
      ],
      href: "/team",
      category: "Team",
    });
  });
});

describe("liveNewQuestion", () => {
  const question = (id: number, actor_name = "Liam") => ({
    comment_id: id,
    lesson_id: 3,
    actor_name,
    lesson_title: "Generics",
    url: `/courses/intro-ts/lessons/3#comment-${id}`,
  });
  // A batch of Questions 1, 2 and 3: Knock's merged data is the newest's.
  const batch = {
    data: question(3, "Maya"),
    total_activities: 3,
    activities: [
      { data: question(1) },
      { data: question(2, "Noor") },
      { data: question(3, "Maya") },
    ],
  };

  it("counts every Question when all are live, describing the latest", () => {
    expect(liveNewQuestion(batch, new Set([1, 2, 3]))).toEqual({
      count: 3,
      data: question(3, "Maya"),
    });
  });

  it("leaves deleted Questions out of the count", () => {
    expect(liveNewQuestion(batch, new Set([1, 3]))?.count).toBe(2);
  });

  it("describes and links to the latest live Question when the latest is deleted", () => {
    expect(liveNewQuestion(batch, new Set([1, 2]))).toEqual({
      count: 2,
      data: question(2, "Noor"),
    });
  });

  it("reads as the one live Question's asker when only one is left", () => {
    expect(
      describeNotification(
        "new-question",
        liveNewQuestion(batch, new Set([2]))?.data,
        liveNewQuestion(batch, new Set([2]))?.count
      )?.sentence
    ).toEqual([
      { text: "Noor", bold: true },
      { text: " asked a question on ", bold: false },
      { text: "Generics", bold: true },
    ]);
  });

  it("hides the row when no Question in it is live", () => {
    expect(liveNewQuestion(batch, new Set())).toBeNull();
  });

  it("subtracts only the deleted Questions it can see when Knock lists fewer activities than the total", () => {
    // 12 Questions, of which Knock lists the last 10 (3 to 12); 4 is deleted.
    const listed = Array.from({ length: 10 }, (_, i) => ({
      data: question(i + 3),
    }));
    const live = new Set(listed.map((a) => a.data.comment_id));
    live.delete(4);
    expect(
      liveNewQuestion(
        { data: question(12), total_activities: 12, activities: listed },
        live
      )
    ).toEqual({ count: 11, data: question(12) });
  });

  it("falls back to Knock's count and data when liveness is unknown", () => {
    expect(liveNewQuestion(batch, null)).toEqual({
      count: 3,
      data: question(3, "Maya"),
    });
  });

  it("counts a lone New question without activities as one", () => {
    expect(liveNewQuestion({ data: question(5) }, new Set([5]))).toEqual({
      count: 1,
      data: question(5),
    });
  });
});

describe("newQuestionCommentIds", () => {
  it("collects the Question ids from each activity, ignoring what it can't read", () => {
    expect(
      newQuestionCommentIds({
        data: { comment_id: 9 },
        activities: [
          { data: { comment_id: 7 } },
          { data: null },
          { data: { comment_id: "8" } },
          { data: { comment_id: 9 } },
        ],
      })
    ).toEqual([7, 9]);
  });

  it("uses the item's own data when it has no activities", () => {
    expect(newQuestionCommentIds({ data: { comment_id: 5 } })).toEqual([5]);
  });
});

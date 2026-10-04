import { describe, expect, it } from "vitest";
import {
  beginDownload,
  canDownload,
  failDownload,
  finishDownload,
  initialDownload,
  isOwner,
  sharePayload,
  verifyUrl,
  type Certificate,
} from "./certificate";
import { chapterLabelFor, ordinalLabel, toCourseModel, type RawCourse } from "./courseModel";
import { resolveProgression, type LessonCompletion } from "./progression";

const labels = { locale: "en", unitWord: "Unit", lessonsWord: "lessons" };

describe("course outline normalization", () => {
  it("spells ordinals and falls back to the numeral for other locales", () => {
    expect(ordinalLabel(1)).toBe("1st");
    expect(ordinalLabel(2)).toBe("2nd");
    expect(ordinalLabel(3)).toBe("3rd");
    expect(ordinalLabel(11)).toBe("11th");
    expect(ordinalLabel(21)).toBe("21st");
    expect(ordinalLabel(0)).toBe("");
    expect(ordinalLabel(3, "fr")).toBe("3");
    expect(chapterLabelFor(2, labels)).toBe("Unit 2nd");
  });

  it("collapses the API's synonyms into one canonical outline", () => {
    const raw: RawCourse = {
      id: 7,
      image_url: "https://cdn.test/cover.png",
      name: "Intro to Widgets",
      is_enrolled: true,
      content_units: [
        {
          id: 1,
          title: "Getting started",
          lessons: [
            { id: 10, slug: "welcome", title: "Welcome", type: "video", completed: true },
            { id: 11, slug: "setup", name: "Setup", type: "mystery" },
          ],
        },
        { id: 2, name: "Widgets deep dive", lessons: [] },
      ],
    };

    const course = toCourseModel(raw, labels);

    expect(course.banner).toBe("https://cdn.test/cover.png");
    expect(course.enrolled).toBe(true);
    expect(course.currentLessonSlug).toBe("welcome");
    expect(course.units).toHaveLength(2);
    expect(course.units[0].name).toBe("Getting started");
    expect(course.units[0].chapterLabel).toBe("Unit 1st");
    expect(course.units[0].meta).toBe("Unit 1st (2 lessons)");
    expect(course.units[0].thumbnail).toBe("https://cdn.test/cover.png");
    expect(course.units[0].lessons[1].type).toBe("video");
    expect(course.units[0].lessons[1].name).toBe("Setup");
    expect(course.units[1].chapterLabel).toBe("Unit 2nd");
    expect(course.units[1].lessonCount).toBe(0);
  });

  it("survives a partial outline with no units or slugs", () => {
    const course = toCourseModel({ id: 1, name: "Empty" }, labels);

    expect(course.units).toEqual([]);
    expect(course.currentLessonSlug).toBeNull();
    expect(course.enrolled).toBe(false);
    expect(course.certificateNumber).toBeNull();
  });
});

const completion = (overrides: Partial<LessonCompletion> = {}): LessonCompletion => ({
  finished: true,
  quizRequired: false,
  quizPassed: false,
  passingPercent: 60,
  scorePercent: null,
  nextLessonId: null,
  nextLessonSlug: null,
  certificateNumber: null,
  ...overrides,
});

describe("progression gating", () => {
  it("does not move before the lesson is marked finished", () => {
    const result = resolveProgression(completion({ finished: false, nextLessonSlug: "next" }));

    expect(result.canAdvance).toBe(false);
    expect(result.reason).toBe("lesson_not_finished");
  });

  it("refuses to advance past a quiz that did not pass, next lesson or not", () => {
    const result = resolveProgression(
      completion({ quizRequired: true, quizPassed: false, nextLessonSlug: "next" }),
    );

    expect(result.canAdvance).toBe(false);
    expect(result.certificateOffered).toBe(false);
    expect(result.nextLesson).toBeNull();
    expect(result.reason).toBe("quiz_not_passed");
  });

  it("advances to the next lesson when there is one", () => {
    const result = resolveProgression(
      completion({ nextLessonId: 11, nextLessonSlug: "setup" }),
    );

    expect(result.canAdvance).toBe(true);
    expect(result.nextLesson).toEqual({ id: 11, slug: "setup" });
    expect(result.reason).toBe("advance_to_next_lesson");
  });

  // The regression this case exists for: no next lesson used to mean "finished",
  // which offered a certificate on a course whose backend had issued none.
  it("does not offer a certificate just because the next-lesson pointer ran out", () => {
    const result = resolveProgression(completion({ quizRequired: true, quizPassed: true }));

    expect(result.canAdvance).toBe(false);
    expect(result.certificateOffered).toBe(false);
    expect(result.reason).toBe("done_without_certificate");
  });

  it("offers the certificate only when one was actually issued", () => {
    const result = resolveProgression(
      completion({ quizRequired: true, quizPassed: true, certificateNumber: "CERT-2026-0001" }),
    );

    expect(result.canAdvance).toBe(false);
    expect(result.certificateOffered).toBe(true);
    expect(result.reason).toBe("certificate_offered");
  });

  it("treats a blank certificate number as not issued", () => {
    const result = resolveProgression(
      completion({ certificateNumber: "   " }),
    );

    expect(result.certificateOffered).toBe(false);
    expect(result.reason).toBe("done_without_certificate");
  });
});

const certificate: Certificate = {
  number: "CERT/2026/42",
  holderName: "  Ada   Lovelace ",
  courseName: "Intro to Widgets",
  courseSlug: "intro-to-widgets",
  issuedAt: "2026-03-01T00:00:00Z",
  duration: "4h",
};

describe("public certificate", () => {
  it("matches the holder by folded name, never as an access check", () => {
    expect(isOwner(certificate, { name: "ada lovelace" })).toBe(true);
    expect(isOwner(certificate, { name: "Grace Hopper" })).toBe(false);
    expect(isOwner(certificate, { name: null })).toBe(false);
  });

  it("builds an encoded verification URL", () => {
    expect(verifyUrl("https://learn.test/", "CERT/2026/42")).toBe(
      "https://learn.test/courses/certificate/CERT%2F2026%2F42",
    );
  });

  it("picks self-wording for the holder and third-person wording otherwise", () => {
    const copy = {
      selfText: "I earned {course} on Learn.",
      otherText: "{name} earned {course} on Learn.",
      hint: "View the verified certificate.",
    };

    expect(sharePayload(certificate, { name: "Ada Lovelace" }, copy, "https://learn.test").text).toBe(
      "I earned Intro to Widgets on Learn.",
    );
    expect(sharePayload(certificate, { name: "Someone Else" }, copy, "https://learn.test").text).toBe(
      "Ada   Lovelace earned Intro to Widgets on Learn.",
    );
  });

  it("runs the download as an idempotent state machine", () => {
    expect(canDownload(initialDownload)).toBe(true);

    const preparing = beginDownload(initialDownload);
    expect(preparing).toEqual({ status: "preparing" });
    expect(beginDownload(preparing)).toBe(preparing);
    expect(canDownload(preparing)).toBe(false);

    const failed = failDownload(preparing, "render failed");
    expect(canDownload(failed)).toBe(true);

    expect(finishDownload(beginDownload(failed), "blob:c42")).toEqual({
      status: "ready",
      url: "blob:c42",
    });
  });
});

/**
 * One canonical outline, built once.
 *
 * The course API grew a field at a time, so the same idea arrives under
 * several spellings: a name is `name` here and `title` there, an enrollment
 * flag is `enrolled` on some payloads and `is_enrolled` on others, and an image
 * may be a `banner_image_url`, an `image_url`, or both. Every screen that read
 * the raw payload had to remember which spelling it was looking at.
 *
 * `toCourseModel` is the only place that translation happens. Downstream code
 * sees `Course`, `Unit`, and `Lesson` — one shape, one set of fallbacks — so an
 * API that adds a synonym next quarter is a one-line change here instead of a
 * scattered `?? course.is_enrolled ??` in every component.
 */

export type LessonType = "video" | "text" | "quiz";

export interface RawLesson {
  id?: number;
  slug?: string;
  name?: string;
  title?: string;
  type?: string;
  completed?: boolean;
  top_success_degree?: number | null;
  duration?: string;
  image_url?: string | null;
}

export interface RawUnit {
  id: number;
  name?: string;
  title?: string;
  thumbnail?: string;
  meta?: string;
  lessons?: RawLesson[];
}

export interface RawCourse {
  id: number;
  slug?: string;
  name: string;
  image_url?: string;
  banner_image_url?: string;
  enrolled?: boolean;
  is_enrolled?: boolean;
  is_course_finished?: boolean;
  certificate_number?: string | null;
  current_lesson_slug?: string | null;
  content_units?: RawUnit[];
}

export interface Lesson {
  id: number;
  slug: string | null;
  name: string;
  type: LessonType;
  completed: boolean;
  topScore: number | null;
  duration: string | null;
}

export interface Unit {
  id: number;
  name: string;
  chapterLabel: string;
  lessonCount: number;
  meta: string;
  thumbnail: string | null;
  lessons: Lesson[];
}

export interface Course {
  id: number;
  slug: string | null;
  name: string;
  banner: string;
  enrolled: boolean;
  finished: boolean;
  certificateNumber: string | null;
  currentLessonSlug: string | null;
  units: Unit[];
}

/** Words a caller supplies so the model carries no hard-coded locale. */
export interface OutlineLabels {
  locale: string;
  unitWord: string;
  lessonsWord: string;
}

const LESSON_TYPES: readonly LessonType[] = ["video", "text", "quiz"];

const asLessonType = (value: string | undefined): LessonType =>
  LESSON_TYPES.includes(value as LessonType) ? (value as LessonType) : "video";

const firstNonEmpty = (...values: (string | null | undefined)[]): string | null =>
  values.find((value): value is string => typeof value === "string" && value.trim() !== "") ??
  null;

/**
 * A numeral ordinal, not a word list: "1st", "2nd", "42nd". Locales that spell
 * ordinals differently fall back to the bare numeral in the label — correct,
 * never off by a translation table someone forgot to extend past ten.
 */
export function ordinalLabel(order: number, locale = "en"): string {
  if (!Number.isFinite(order) || order < 1) return "";

  const whole = Math.trunc(order);
  if (!locale.toLowerCase().startsWith("en")) return String(whole);

  const mod100 = whole % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${whole}th`;

  switch (whole % 10) {
    case 1:
      return `${whole}st`;
    case 2:
      return `${whole}nd`;
    case 3:
      return `${whole}rd`;
    default:
      return `${whole}th`;
  }
}

export function chapterLabelFor(order: number, labels: OutlineLabels): string {
  const ordinal = ordinalLabel(order, labels.locale);
  return ordinal ? `${labels.unitWord} ${ordinal}` : "";
}

const toLesson = (lesson: RawLesson): Lesson => ({
  id: lesson.id ?? 0,
  slug: firstNonEmpty(lesson.slug),
  name: firstNonEmpty(lesson.name, lesson.title) ?? "",
  type: asLessonType(lesson.type),
  completed: lesson.completed ?? false,
  topScore: lesson.top_success_degree ?? null,
  duration: firstNonEmpty(lesson.duration),
});

export function toCourseModel(raw: RawCourse, labels: OutlineLabels): Course {
  const banner = firstNonEmpty(raw.banner_image_url, raw.image_url) ?? "";

  const units: Unit[] = (raw.content_units ?? []).map((unit, index) => {
    // The chapter label is derived from position, not trusted from the payload:
    // an outline reordered at the API must relabel its units too.
    const chapterLabel = chapterLabelFor(index + 1, labels);
    const lessons = (unit.lessons ?? []).map(toLesson);

    return {
      id: unit.id,
      name: firstNonEmpty(unit.name, unit.title) ?? "",
      chapterLabel,
      lessonCount: lessons.length,
      meta:
        firstNonEmpty(unit.meta) ??
        `${chapterLabel} (${lessons.length} ${labels.lessonsWord})`,
      thumbnail: firstNonEmpty(unit.thumbnail, banner),
      lessons,
    };
  });

  const firstSlug =
    units.flatMap((unit) => unit.lessons).find((lesson) => lesson.slug !== null)?.slug ?? null;

  return {
    id: raw.id,
    slug: firstNonEmpty(raw.slug),
    name: raw.name,
    banner,
    enrolled: raw.enrolled ?? raw.is_enrolled ?? false,
    finished: raw.is_course_finished ?? false,
    certificateNumber: firstNonEmpty(raw.certificate_number),
    // An explicit resume point wins; otherwise start where the outline starts.
    currentLessonSlug: firstNonEmpty(raw.current_lesson_slug, firstSlug),
    units,
  };
}

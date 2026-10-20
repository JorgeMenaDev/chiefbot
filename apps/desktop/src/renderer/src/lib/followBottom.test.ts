import { expect, test } from "bun:test";
import { bottomFollower } from "./followBottom.ts";

// A 400px lane over `content` pixels; like the browser, scrollTop clamps to the bottom.
class FakeLane {
  content = 1000;
  readonly clientHeight = 400;
  private top = 0;
  get scrollHeight() {
    return this.content;
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(value: number) {
    this.top = Math.max(0, Math.min(value, this.content - this.clientHeight));
  }
}

test("a pin's own scroll event, arriving after 40px more content, does not stop following", () => {
  const lane = new FakeLane();
  const follow = bottomFollower();
  follow.pin(lane);

  lane.content += 40; // a streamed chunk lands before the pin's scroll event
  follow.scrolled(lane);
  follow.grew(lane);

  expect(lane.scrollTop).toBe(640);
});

test("scrolling up stops following, and scrolling back to the bottom resumes it", () => {
  const lane = new FakeLane();
  const follow = bottomFollower();
  follow.pin(lane);

  lane.scrollTop = 300;
  follow.scrolled(lane);
  lane.content += 40;
  follow.grew(lane);
  expect(lane.scrollTop).toBe(300);

  lane.scrollTop = lane.scrollHeight;
  follow.scrolled(lane);
  lane.content += 40;
  follow.grew(lane);
  expect(lane.scrollTop).toBe(680);
});

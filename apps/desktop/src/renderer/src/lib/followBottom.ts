// What of a scrolling element the follower reads and moves (an HTMLElement in the app).
type Scroller = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

// Keeps a chat lane at its bottom while the user is there (Chat.tsx's Timeline).
//   pin       go to the bottom and follow it (a new chat, the user's new message)
//   grew      the content or the lane resized: back to the bottom while following
//   scrolled  a scroll event. Only the user stops the following: a scroll counts
//             as theirs when it moved up from where the follower last pinned. A
//             pin's own scroll event can arrive after more content grew, and must
//             not stop it. Back within `slackPx` of the bottom, following resumes.
export function bottomFollower(slackPx = 16) {
  let following = true;
  let pinnedTop = 0;
  const toBottom = (scroller: Scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
    pinnedTop = scroller.scrollTop;
  };
  return {
    pin(scroller: Scroller) {
      following = true;
      toBottom(scroller);
    },
    grew(scroller: Scroller) {
      if (following) toBottom(scroller);
    },
    scrolled(scroller: Scroller) {
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (gap <= slackPx) following = true;
      else if (scroller.scrollTop < pinnedTop) following = false;
    },
  };
}

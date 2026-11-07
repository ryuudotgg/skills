import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { instantText, parseTime } from "skills-core";
import { authorized, initialSnapshot, startFeed, type FeedSnapshot } from "./client.ts";
import { Shell } from "./shell.tsx";
import { tokenOf } from "./url.ts";

const FEED_EVERY_MS = 5_000;

type Place = { pathname: string; search: string; hash: string };

const here = (): Place => ({
  pathname: location.pathname,
  search: location.search,
  hash: location.hash,
});

function go(path: string, search: string, setPlace: (place: Place) => void) {
  const target = `${path}${search}`;
  if (target !== `${location.pathname}${location.search}`)
    history.pushState(null, "", `${target}${location.hash}`);

  setPlace(here());
}

function inApp(event: MouseEvent): HTMLAnchorElement | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;

  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.target !== "" || link.hasAttribute("download"))
    return undefined;

  return link.origin === location.origin ? link : undefined;
}

const token = tokenOf(location.hash);
const request = authorized((path, init) => fetch(path, init), token);
async function readBlob(sha256: string): Promise<string | undefined> {
  const response = await request(`/blobs/${sha256}`, {});
  return response.ok ? response.text() : undefined;
}

function App() {
  const [place, setPlace] = useState(here);
  const [feed, setFeed] = useState<FeedSnapshot>(() => initialSnapshot(Date.now));

  useEffect(
    () =>
      startFeed({
        token,
        fetch: (path, init) => fetch(path, init),
        clock: Date.now,
        every: FEED_EVERY_MS,
        onChange: setFeed,
      }),
    [],
  );

  useEffect(() => {
    const back = () => setPlace(here());
    const follow = (event: MouseEvent) => {
      const link = inApp(event);
      if (!link) return;

      event.preventDefault();
      go(link.pathname, link.search, setPlace);
    };

    const rekey = () => {
      if (tokenOf(location.hash) !== token) location.reload();
    };

    window.addEventListener("popstate", back);
    window.addEventListener("hashchange", rekey);
    document.addEventListener("click", follow);

    return () => {
      window.removeEventListener("popstate", back);
      window.removeEventListener("hashchange", rekey);
      document.removeEventListener("click", follow);
    };
  }, []);

  const travel = (text: string | undefined) => {
    const at = text === undefined ? undefined : parseTime(text);
    const search =
      text === undefined
        ? ""
        : `?at=${at === undefined ? encodeURIComponent(text) : instantText(at)}`;

    go(location.pathname, search, setPlace);
  };

  return (
    <Shell
      pathname={place.pathname}
      search={place.search}
      hash={place.hash}
      events={feed.events}
      wall={feed.checked}
      feed={feed.status}
      blob={readBlob}
      onTravel={travel}
    />
  );
}

const dark = matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyScheme();
dark.addEventListener("change", applyScheme);

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

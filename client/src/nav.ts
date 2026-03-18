/** Rewrite all nav links to carry over current query params (track, local, etc.) */
export function propagateQueryParams(): void {
  const search = window.location.search;
  if (!search) return;
  document.querySelectorAll<HTMLAnchorElement>("a.nav-link").forEach((a) => {
    const url = new URL(a.href, window.location.origin);
    const currentParams = new URLSearchParams(search);
    currentParams.forEach((val, key) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, val);
    });
    a.href = url.pathname + url.search;
  });
}

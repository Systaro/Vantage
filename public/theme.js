// Loaded synchronously in <head>: applies the stored theme before the first paint, so a dark
// theme never flashes white. Without a stored choice the page follows the operating system.
(function () {
  try {
    var theme = localStorage.getItem("vantage-theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (e) {}
})();

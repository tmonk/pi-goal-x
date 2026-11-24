/** Root ignores file permissions, so chmod-based fault injection cannot fail a write. */
export const skipWhenRoot = { skip: process.getuid?.() === 0 ? "running as root: permission faults cannot be injected" : false };

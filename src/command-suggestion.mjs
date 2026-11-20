/** Prefer a short completion, then the closest command within two edits. */
export function closestCommand(input, commands) {
  if (!input) return undefined;
  const completion = commands.filter((command) => command.startsWith(input) && command.length - input.length <= 2)
    .sort((a, b) => a.length - b.length)[0];
  if (completion) return completion;
  let closest;
  let bestDistance = 3;
  for (const command of commands) {
    if (Math.abs(command.length - input.length) > 2) continue;
    const distance = editDistance(input, command);
    if (distance < bestDistance) { closest = command; bestDistance = distance; }
  }
  return closest;
}

function editDistance(input, command) {
  let previous = Array.from({ length: command.length + 1 }, (_, i) => i);
  for (let i = 1; i <= input.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= command.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(input[i - 1] !== command[j - 1]));
    }
    previous = current;
  }
  return previous[command.length];
}

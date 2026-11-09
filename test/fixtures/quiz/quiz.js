// Classic (non-module) script — DOM manipulation that proves JS executes
function handleAnswer(correct) {
  var el = document.getElementById('result');
  if (correct) {
    el.textContent = 'Correct!';
    el.style.color = 'green';
  } else {
    el.textContent = 'Wrong, try again.';
    el.style.color = 'red';
  }
  // Test in-memory localStorage polyfill
  try {
    localStorage.setItem('lastAnswer', correct ? 'correct' : 'wrong');
  } catch (e) {
    console.warn('localStorage not available:', e);
  }
}

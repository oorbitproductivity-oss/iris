// Sample app for the Phase-6 browser test fixture.
//
// Bug (intentional): the input value is not cleared after adding a todo,
// so typing a second todo concatenates onto the first.
//
// A correct fix is to add `input.value = '';` after the appendChild call.

(function () {
  const form = document.getElementById('form');
  const input = document.getElementById('todo-input');
  const list = document.getElementById('list');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    const li = document.createElement('li');
    li.textContent = v;
    list.appendChild(li);
    // BUG: missing `input.value = '';` here.
  });
})();

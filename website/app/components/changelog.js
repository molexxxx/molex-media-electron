$.component('changelog-page', {
    render()
    {
        return `
<div class="wrap">
    <header class="page-head">
        <h1>Changelog</h1>
        <p class="lead">Every release, newest first. Notes come from the project's CHANGELOG.md where it has an entry, and from the GitHub release otherwise.</p>
    </header>
    <release-list></release-list>
</div>`;
    },
});

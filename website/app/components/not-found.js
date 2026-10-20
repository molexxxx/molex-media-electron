import { icon } from '../icons.js';
import { link } from '../parts.js';

$.component('not-found', {
    render()
    {
        return `
<div class="wrap nf">
    <h1>This page does not exist.</h1>
    <p class="lead">The link may be old, or the address may have a typo. These are the pages that do exist:</p>
    <p class="get-more">
        ${link('/', 'Home', 'btn btn-ghost')}
        ${link('/features', 'Features', 'btn btn-ghost')}
        ${link('/download', `${icon('download', 16)}Download`, 'btn btn-primary')}
    </p>
</div>`;
    },
});

let queryRunning = false;
let queryExecutionId = null;
let queryExecutionStart = 0;
let runningTimer = null;

const $query = $('#query');
const $table = $('#table');
const $timezone = $('#timezone');
const $runQueryButton = $('#runQuery');
const $clearQueryButton = $('#clearQuery');
const $debug = $('#debug');
const $download = $('#download');

const updateQueryButton = (override) => $runQueryButton.html(override ? override : (queryRunning ? 'Stop Query' : 'Run Query'));

const debug = (text, resetQuery) => {
  $debug.html(text);
  if (resetQuery) {
    queryRunning = false;
    queryExecutionId = null;
    queryExecutionStart = 0;
    clearInterval(runningTimer);
    updateQueryButton();
    $clearQueryButton.show();
  }
};

const ajaxError = (err) => {
  try {
    const json = JSON.parse(err.responseText);
    if (json.reload) {
      window.location.reload();
    }
    else {
      debug(json && json.error ? json.error : err, true);
    }
  }
  catch (e) {
    debug(err, true);
  }
};

$query.val(window.localStorage.getItem('query') || '');
$table.val(window.localStorage.getItem('table') || 'processed_logs');
$timezone.val(window.localStorage.getItem('timezone') || 'ET');

$clearQueryButton.on('click', () => {
  $query.val('').focus();
  window.localStorage.removeItem('query');
  $download.hide();
});

$runQueryButton.on('click', () => {
  queryRunning = !queryRunning;
  updateQueryButton();

  if (queryRunning) {
    const query = $query.val().trim();
    const table = $table.val();
    const timezone = $timezone.val();

    window.localStorage.setItem('query', query);
    window.localStorage.setItem('table', table);
    window.localStorage.setItem('timezone', timezone);

    $download.hide();
    $clearQueryButton.hide();
    queryExecutionStart = Date.now();
    const queryParams = {
      type: 'POST',
      url: '/api/query',
      data: JSON.stringify({query: query, table: table, timezone: timezone}),
      contentType:"application/json; charset=utf-8",
      dataType:"json"
    };
    $.ajax(queryParams)
      .done((data) => {
        if (data.reload) {
          window.location.reload();
        }
        else if (data.error) {
          debug(data.error, true);
        }
        else if (!data.result || !data.result.QueryExecutionId) {
          debug('Missing result.QueryExecutionId in query response!', true);
        }
        else {
          queryExecutionId = data.result.QueryExecutionId;
          runningTimer = setInterval(updateRunningTimer, 100);
          debug('Running...');
          console.log('SQL:', data.sql);
          pollQueryExecution();
        }
      })
      .fail((err) => {
        ajaxError(err);
      });
  }
  else if (queryExecutionId) {
    $runQueryButton.attr("disabled", "disabled");
    updateQueryButton('Cancelling Query...');
    debug('Cancelling query...');
    const queryParams = {
      type: 'POST',
      url: '/api/cancelQuery',
      data: JSON.stringify({queryExecutionId: queryExecutionId}),
      contentType:"application/json; charset=utf-8",
      dataType:"json"
    };
    $.ajax(queryParams)
      .done((data) => {
        $runQueryButton.attr("disabled", null);
        updateQueryButton();
        if (data.reload) {
          window.location.reload();
        }
        else if (data.error) {
          debug(data.error, true);
        }
        else {
          debug('Cancelled query!', true);
        }
      });
  }
});

const pollQueryExecution = () => {
  if (!queryExecutionId) {
    return;
  }

  const pollParams = {
    type: 'GET',
    url: '/api/queryExecution',
    data: {queryExecutionId},
    dataType:"json"
  };
  $.ajax(pollParams)
    .done((data) => {
      if (data.reload) {
        window.location.reload();
      }
      else if (data.error) {
        debug(data.error, true);
      }
      else {
        const result = data.result && data.result.QueryExecution;
        if (!result) {
          debug('Invalid result from query execution poll!', true);
        }
        else if (result.Status && (result.Status.State === 'FAILED')) {
          debug(result.Status.StateChangeReason, true);
        }
        else if (result.Status && (result.Status.State === 'SUCCEEDED')) {
          var stats = result.Statistics;
          $download.html(`<a href='/api/downloadCSV?queryExecutionId=${queryExecutionId}'>Download CSV</a>`).show();
          $clearQueryButton.show();
          debug(`Query complete! ${stats.DataScannedInBytes} bytes scanned in ${stats.EngineExecutionTimeInMillis / 1000} seconds.`, true);
        }
        else {
          setTimeout(pollQueryExecution, 1000);
        }
      }
    })
    .fail((err) => {
      ajaxError(err);
    });
};

const updateRunningTimer = () => {
  debug(`Running ${((Date.now() - queryExecutionStart) / 1000).toFixed(1)} seconds ...`);
};
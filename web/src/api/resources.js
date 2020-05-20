import {
  from,
  forkJoin,
  EMPTY
} from "rxjs";
import axios from "axios";
import {
  // finalize,
  catchError,
  pluck,
  map,
  tap,
  finalize
} from "rxjs/operators";

import store from "@/store";

import {
  timeParse,
  timeFormat,
  utcParse
} from "d3";

import {
  cloneDeep
} from "lodash";

function filterString2Arr(filterString) {
  return filterString.split(";").map(d => {
    const filters = d.split(":");
    return {
      key: filters[0],
      values: filters[1].split(",")
    };
  });
}

function filterArr2String(filterArr) {
  return filterArr
    .map(d => `${d.key}:("${d.values.join('","')}")`)
    .join(" AND ");
}

export function getResources(
  apiUrl,
  queryString,
  filterString,
  sort,
  size,
  page
) {
  var comboString;
  var filterArr = [];
  if (!queryString && !filterString) {
    comboString = "__all__";
  } else if (!queryString) {
    filterArr = filterString2Arr(filterString);
    comboString = filterArr2String(filterArr);
  } else if (!filterString) {
    comboString = queryString;
  } else {
    filterArr = filterString2Arr(filterString);
    comboString = `${queryString} AND ${filterArr2String(filterArr)}`;
  }


  store.state.admin.loading = true;
  return forkJoin([
    getMostRecent(apiUrl, comboString),
    getMetadataArray(apiUrl, comboString, sort, size, page),
    getResourceFacets(apiUrl, comboString, filterArr)
  ]).pipe(
    map(([recent, results, facets]) => {
      results["recent"] = recent;
      results["facets"] = facets;
      return results;
    }),
    catchError(e => {
      console.log("%c Error in getting resource metadata!", "color: red");
      console.log(e);
      return from([]);
    }),
    finalize(() => (store.state.admin.loading = false))
  );
}

export function getMetadataArray(apiUrl, queryString, sort, size, page) {
  const maxDescriptionLength = 75;
  // store.state.admin.loading = true;
  const timestamp = Math.round(new Date().getTime() / 1e5);
  return from(
    axios.get(
      `${apiUrl}query?q=${queryString}&sort=${sort}&size=${size}&from=${page}&timestamp=${timestamp}`, {
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
  ).pipe(
    pluck("data"),
    map(results => {
      console.log(results);
      const resources = results.hits;
      const total = results.total;

      resources.forEach(d => {
        d["date"] = d.dateModified ?
          d.dateModified :
          d.datePublished ?
          d.datePublished :
          d.dateCreated;
        d["longDescription"] = d.abstract ? d.abstract : d.description;
        if (d.longDescription) {
          let descriptionArray = d.longDescription.split(" ");
          d["shortDescription"] = descriptionArray
            .slice(0, maxDescriptionLength)
            .join(" ");
          d["descriptionTooLong"] =
            descriptionArray.length >= maxDescriptionLength;
          d["descriptionExpanded"] = false;
        }
      });

      resources.sort((a, b) => (a.date > b.date ? -1 : 1));
      return {
        results: resources,
        total: total
      };
    }),
    catchError(e => {
      console.log("%c Error in getting resource metadata!", "color: red");
      console.log(e);
      return from([]);
    })
    // finalize(() => (store.state.admin.loading = false))
  );
}

export function getResourceMetadata(apiUrl, id) {
  store.state.admin.loading = true;
  const timestamp = Math.round(new Date().getTime() / 1e5);
  const query = id.startsWith("zenodo") ? id : `_id:"${id}"`;
  
  return from(
    axios.get(`${apiUrl}query?q=${query}&size=1&timestamp=${timestamp}`, {
      headers: {
        "Content-Type": "application/json"
      }
    })
  ).pipe(
    pluck("data", "hits"),
    map(results => {
      const metadata = results[0];

      metadata["date"] = metadata.dateModified ?
        metadata.dateModified :
        metadata.datePublished ?
        metadata.datePublished :
        metadata.dateCreated;
      console.log(metadata);

      return metadata;
    }),
    catchError(e => {
      console.log("%c Error in getting resource metadata!", "color: red");
      console.log(e);
      return from([]);
    }),
    finalize(() => (store.state.admin.loading = false))
  );
}

export function getResourceFacets(
  apiUrl,
  queryString,
  filterArr,
  facets = [
    "@type",
    "curatedBy.name",
    "keywords",
    "topicCategory",
    "funding.funder.name",
    "measurementTechnique",
    "variableMeasured"
  ]
) {
  if (!queryString) {
    queryString = "__all__";
  }

  const sortOrder = [
    "@type",
    "topicCategory",
    "curatedBy.name",
    "keywords",
    "funding.funder.name",
    "measurementTechnique",
    "variableMeasured"
  ];

  const facetString = facets.join(",");
  const timestamp = Math.round(new Date().getTime() / 1e5);
  return from(
    axios.get(
      `${apiUrl}query?q=${queryString}&size=0&facet_size=100&facets=${facetString}&timestamp=${timestamp}`, {
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
  ).pipe(
    pluck("data", "facets"),
    map(results => {
      const facets = Object.keys(results).map(key => {
        const filters = filterArr.filter(
          d => d.key == key.replace(".keyword", "")
        );
        results[key]["terms"].forEach(d => {
          d["checked"] =
            filters.length == 1 ? filters[0].values.includes(d.term) : false;
          d["checked2"] = d.term;
          d["checked3"] = filters;
          d["checked4"] = filterArr;
          d["checked5"] = filterArr;
        });
        return {
          variable: key
            .replace(".keyword", "")
            .replace("@", "")
            .replace("curatedBy.name", "source")
            .replace("funding.funder.name", "funding")
            .replace("measurementTechnique", "measurement technique")
            .replace("topicCategory", "topic")
            .replace("variableMeasured", "variable measured"),
          id: key.replace(".keyword", ""),
          counts: results[key]["terms"],
          filtered: cloneDeep(results[key]["terms"]),
          total: results[key]["terms"].length,
          num2Display: 5,
          expanded: true
        };
      });

      facets.sort((a, b) => sortOrder.indexOf(a.id) - sortOrder.indexOf(b.id));

      return facets;
    }),
    catchError(e => {
      console.log("%c Error in getting resource facets!", "color: red");
      console.log(e);
      return from([]);
    })
  );
}

export function getMostRecent(
  apiUrl,
  queryString,
  sortVar = "-datePublished",
  num2Return = 3,
  fields = [
    "@type",
    "name",
    "author",
    "creator",
    "datePublished",
    "dateModified",
    "dateCreated"
  ]
) {
  const timestamp = Math.round(new Date().getTime() / 1e5);
  const fieldString = fields.join(",");
  return from(
    axios.get(
      `${apiUrl}query?q=${queryString}&field=${fieldString}&size=${num2Return}&sort=${sortVar}&timestamp=${timestamp}`, {
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
  ).pipe(
    pluck("data", "hits"),
    map(results => {
      results.forEach(d => {
        d["date"] = d.dateModified ?
          d.dateModified :
          d.datePublished ?
          d.datePublished :
          d.dateCreated;
      });

      return results;
    }),
    catchError(e => {
      console.log("%c Error in getting resource facets!", "color: red");
      console.log(e);
      return from([]);
    })
  );
}

export function getMostRecentGroup(apiUrl, sortVar, num2Return) {
  return forkJoin([getMostRecent(apiUrl, "@type:Publication", sortVar, num2Return), getMostRecent(apiUrl, "@type:Dataset", sortVar, num2Return), getMostRecent(apiUrl, "@type:ClinicalTrial", sortVar, num2Return)]).pipe(
    map(([pubs, datasets, trials]) => {
      return({publication: pubs, dataset: datasets, clinicaltrial: trials})
    })
  )
}

export function getQuerySummaries(queries, apiUrl) {
  queries.forEach(d => {
    d["query"] = encodeURIComponent(`("${d.terms.join('" OR "')}")`);
  });

  return forkJoin(...queries.map(d => getQuerySummary(d.query, apiUrl))).pipe(
    map(results => {
      results.forEach((d, idx) => {
        d["key"] = queries[idx];
        d.types.forEach(type => {
          type["x"] = d.key.name;
          type["y"] = type.term
        })
      })
      return (results)
    })
  )
}

export function getQuerySummary(queryString, apiUrl, fields = "@type,name,identifierSource,interventions,studyStatus,armGroup,studyLocation,studyDesign,datePublihsed,journalName, journalNameAbbrev, author", facets = "@type, curatedBy.name") {
  const timestamp = Math.round(new Date().getTime() / 1e5);

  return from(axios.get(
    // `${apiUrl}query?q=name:${queryString} OR description:${queryString}&timestamp=${timestamp}&size=100&fields=${fields}&facets=${facets}&facet_size=100`, {
    `${apiUrl}query?q=${queryString}&timestamp=${timestamp}&size=1000&fields=${fields}&facets=${facets}&facet_size=25`, {
      headers: {
        "Content-Type": "application/json"
      }
    }
  )).pipe(
    pluck("data"),
    map(results => {
      results["types"] = results["facets"]["@type"]["terms"];
      return (results)
    }))
}

export function getCTSummary(apiUrl) {
  const timestamp = Math.round(new Date().getTime() / 1e5);

  return from(axios.get(
    `${apiUrl}query?q=name:%22hydroxychloroquine%22%20OR%20description:%22hydroxychloroquine%22&fields=armGroup.name,armGroup.intervention,dateCreated,%20studyStatus&size=1000&timestamp=${timestamp}`, {
      headers: {
        "Content-Type": "application/json"
      }
    }
  )).pipe(
    pluck("data", "hits"),
    map(results => {
      return (results)
    }))
}

export function getSourceSummary(apiUrl) {
  const timestamp = Math.round(new Date().getTime() / 1e5);

  return forkJoin([getSourceCounts(apiUrl), getResourcesMetadata(apiUrl)]).pipe(
    map(([results, metadata]) => {
      results["dateModified"] = metadata;
      return (results)
    })
  )
}


export function getSourceCounts(apiUrl) {
  const timestamp = Math.round(new Date().getTime() / 1e5);

  return from(axios.get(
    `${apiUrl}query?aggs=@type(curatedBy.name)&facet_size=100&timestamp=${timestamp}`, {
      headers: {
        "Content-Type": "application/json"
      }
    }
  )).pipe(pluck("data"), map(results => {
    const cleaned = results.facets["@type"]["terms"].flatMap(d => {
      const source = {
        name: d.term
      };
      // Temp, till `curatedBy` added for Zenodo
      const zenodo = d["count"] - d["curatedBy.name"]["total"];

      d["curatedBy.name"]["terms"].forEach(source => {
        source["name"] = source.term.replace("ClinicalTrials.gov", "NCT").replace("WHO International Clinical Trials Registry Platform", "WHO");
      })
      if (zenodo) {
        d["curatedBy.name"]["terms"].push({
          name: "Zenodo",
          count: zenodo
        });
      }

      source["children"] = d["curatedBy.name"]["terms"];
      return (source)
    })
    return ({
      total: results.total.toLocaleString(),
      sources: {name: "root", children: cleaned}
    })
  }))
}

export function getResourcesMetadata(apiUrl) {
  const formatDate = timeFormat("%d %B %Y")
  return from(axios.get(`${apiUrl}metadata`)).pipe(
    pluck("data", "build_date"),
    map(metadata => {
      const strictIsoParse = utcParse("%Y-%m-%dT%H:%M:%S.%f");
      const dateUpdated = strictIsoParse(metadata);

      return (formatDate(dateUpdated))
    })
  )
}
